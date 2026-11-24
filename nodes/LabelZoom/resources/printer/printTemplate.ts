import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
	JsonObject,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { labelZoomJsonRequest } from '../../shared/transport';
import { resourceId } from '../../shared/utils';
import { LabelZoomValidationError } from '../../shared/validation';
import {
	copiesField,
	idempotencyKeyField,
	normalizePrintJob,
	printerLocator,
	readCopies,
	readIdempotencyKey,
	templateLocator,
} from './shared';

const showFor = { resource: ['printer'], operation: ['printTemplate'] };

export const printTemplateDescription: INodeProperties[] = [
	printerLocator(showFor),
	templateLocator(showFor),
	{
		displayName: 'Merge Data (JSON)',
		name: 'mergeData',
		type: 'json',
		default: '{}',
		required: true,
		description:
			"Values for the template's merge fields, keyed by field name. Map them from the incoming item. An array of objects prints one label per entry as one batch, and the output then lists the jobs.",
		displayOptions: { show: showFor },
	},
	{
		displayName: 'Validate Merge Fields',
		name: 'validate',
		type: 'boolean',
		default: true,
		description:
			'Whether to reject the job when a required merge field is missing, instead of printing a label with a blank in it',
		displayOptions: { show: showFor },
	},
	copiesField(showFor),
	idempotencyKeyField(showFor),
];

export async function printTemplate(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData> {
	const printerId = resourceId.call(this, 'printerId', itemIndex);
	const templateId = resourceId.call(this, 'templateId', itemIndex);
	const copies = readCopies.call(this, itemIndex);
	const validate = this.getNodeParameter('validate', itemIndex, true) as boolean;
	const idempotencyKey = readIdempotencyKey.call(this, itemIndex);
	const records = readRecords.call(this, itemIndex);

	// Rule P3: one record is sent as that object, several as an array, and none
	// as `{}`. Copies at its default of 1 is left off: the API treats copies=1
	// exactly like no parameter.
	const body: IDataObject | IDataObject[] =
		records.length === 0 ? {} : records.length === 1 ? records[0] : records;
	const query: Record<string, string> = {};
	if (validate) query.validate = 'true';
	if (copies !== 1) query.copies = String(copies);

	// A batch sends one key; the server derives each entry's key from it, so the
	// node must not (rule P4).
	const response = await labelZoomJsonRequest.call(
		this,
		'POST',
		`/api/v3/printers/${encodeURIComponent(printerId)}/templates/${encodeURIComponent(templateId)}/print`,
		body,
		Object.keys(query).length > 0 ? query : undefined,
		{ 'Idempotency-Key': idempotencyKey },
	);

	// One record answers with a single job, and the output stays that job, as it
	// always has. Several answer with a batch (rule P6): `remaining` counts the
	// records at the end that were not submitted, which a resend of the same
	// request with the same key submits.
	if (Array.isArray(response.jobs)) {
		return {
			json: {
				jobs: (response.jobs as JsonObject[]).map(normalizePrintJob),
				remaining: typeof response.remaining === 'number' ? response.remaining : 0,
				message: typeof response.message === 'string' ? response.message : null,
				printerId,
				templateId,
			},
			pairedItem: { item: itemIndex },
		};
	}

	return {
		json: { ...normalizePrintJob(response), printerId, templateId },
		pairedItem: { item: itemIndex },
	};
}

/**
 * Parse Merge Data into its records. An object is one record and an array is
 * one per entry; every entry must be an object, because a bare string or number
 * has no field names to fill (rule P7, as C3 for convert).
 */
function readRecords(this: IExecuteFunctions, itemIndex: number): IDataObject[] {
	const raw: unknown = this.getNodeParameter('mergeData', itemIndex, '{}');

	let parsed: unknown = raw;
	if (typeof raw === 'string') {
		if (raw.trim() === '') return [];
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			throw new NodeOperationError(
				this.getNode(),
				`Merge Data is not valid JSON: ${(error as Error).message}`,
				{ itemIndex },
			);
		}
	}

	const records = Array.isArray(parsed) ? parsed : [parsed];
	for (const record of records) {
		if (typeof record !== 'object' || record === null || Array.isArray(record)) {
			throw new LabelZoomValidationError(
				this.getNode(),
				'data',
				`Every entry in Merge Data must be a JSON object, got ${JSON.stringify(record)}`,
				{ itemIndex },
			);
		}
	}
	// `{}` is "no record": the template prints with its own defaults.
	if (records.length === 1 && Object.keys(records[0] as IDataObject).length === 0) return [];
	return records as IDataObject[];
}
