import type { IExecuteFunctions, INodeExecutionData, INodeProperties, JsonObject } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { labelZoomJsonRequest } from '../../shared/transport';
import { resourceId } from '../../shared/utils';
import {
	copiesField,
	idempotencyKeyField,
	printerLocator,
	readCopies,
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
			"Values for the template's merge fields, keyed by field name. Map them from the incoming item.",
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
	const idempotencyKey = this.getNodeParameter('idempotencyKey', itemIndex, '') as string;
	const rawMergeData = this.getNodeParameter('mergeData', itemIndex, '{}');

	let mergeData: unknown;
	if (typeof rawMergeData === 'string') {
		try {
			mergeData = JSON.parse(rawMergeData);
		} catch (error) {
			throw new NodeOperationError(
				this.getNode(),
				`Merge Data is not valid JSON: ${(error as Error).message}`,
				{ itemIndex },
			);
		}
	} else {
		mergeData = rawMergeData;
	}

	// The endpoint accepts an array and then answers `{ jobs: [...] }` instead of a
	// single job — a different response shape for the same operation. n8n already
	// expresses "many" as many items, and one job per item keeps the idempotency
	// key meaningful, so send a single object and let the item loop do the fan-out.
	if (Array.isArray(mergeData)) {
		throw new NodeOperationError(
			this.getNode(),
			'Merge Data must be a single JSON object, not an array',
			{
				itemIndex,
				description:
					'Send one item per label — this operation runs once per input item and each run produces one print job.',
			},
		);
	}

	// Copies at its default of 1 is left off: the API treats copies=1 exactly like
	// no parameter, and the request stays what it was before the field existed.
	const query: Record<string, string> = {};
	if (validate) query.validate = 'true';
	if (copies !== 1) query.copies = String(copies);

	const headers: Record<string, string> = {};
	if (idempotencyKey !== '') headers['Idempotency-Key'] = idempotencyKey;

	const job = await labelZoomJsonRequest.call(
		this,
		'POST',
		`/api/v3/printers/${encodeURIComponent(printerId)}/templates/${encodeURIComponent(templateId)}/print`,
		mergeData as JsonObject,
		Object.keys(query).length > 0 ? query : undefined,
		headers,
	);

	return {
		json: { ...job, printerId, templateId },
		pairedItem: { item: itemIndex },
	};
}
