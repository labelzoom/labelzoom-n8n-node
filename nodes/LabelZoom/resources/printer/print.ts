import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
	JsonObject,
} from 'n8n-workflow';
import { sleep } from 'n8n-workflow';

import { conversionOptionsField, documentInputFields } from '../../shared/descriptions';
import { SOURCE_FORMATS, formatOptions, sourceMediaType, sourceWireToken } from '../../shared/formats';
import type { ConversionOptions } from '../../shared/options';
import { serializeConversionParams } from '../../shared/options';
import { labelZoomJsonRequest, labelZoomRequest, requestIdOf } from '../../shared/transport';
import { readDocument, resourceId } from '../../shared/utils';
import { TERMINAL_JOB_STATUSES, idempotencyKeyField, printerLocator } from './shared';

const showFor = { resource: ['printer'], operation: ['print'] };

export const printDescription: INodeProperties[] = [
	printerLocator(showFor),
	{
		displayName: 'Source Format',
		name: 'sourceFormat',
		type: 'options',
		noDataExpression: true,
		options: [
			{
				name: 'Auto-Detect',
				value: '',
				description: 'Let LabelZoom identify the format from the file contents',
			},
			...formatOptions(SOURCE_FORMATS.filter((format) => format !== 'url')),
		],
		default: '',
		description:
			'The format of the document you are sending. LabelZoom converts it to the printer\'s native format on the way — a PDF sent to a ZPL printer becomes ZPL automatically.',
		displayOptions: { show: showFor },
	},
	...documentInputFields(showFor),
	idempotencyKeyField(showFor),
	{
		displayName: 'Wait for Completion',
		name: 'waitForCompletion',
		type: 'boolean',
		default: false,
		description:
			'Whether to poll the job until it finishes printing. Without this the node returns as soon as the job is accepted, which is not the same as printed.',
		displayOptions: { show: showFor },
	},
	{
		displayName: 'Timeout (Seconds)',
		name: 'waitTimeout',
		type: 'number',
		default: 120,
		description: 'How long to wait for the job to reach a terminal state before giving up',
		displayOptions: { show: { ...showFor, waitForCompletion: [true] } },
	},
	conversionOptionsField(showFor, 'Transform Options'),
];

/**
 * Poll a job to a terminal state.
 *
 * `dispatched` and `queued` both mean *accepted*, not *printed* — only the agent
 * moves a job past `dispatched`, so a workflow that needs to know the label came
 * out of the printer has to wait for `completed`.
 */
async function waitForJob(
	this: IExecuteFunctions,
	jobId: string,
	timeoutSeconds: number,
	itemIndex: number,
): Promise<JsonObject> {
	const deadline = Date.now() + timeoutSeconds * 1000;
	let delayMs = 1000;
	let job: JsonObject = {};

	while (Date.now() < deadline) {
		await sleep(delayMs);
		job = await labelZoomJsonRequest.call(this, 'GET', `/api/v3/jobs/${encodeURIComponent(jobId)}`);
		if (TERMINAL_JOB_STATUSES.includes(job.status as (typeof TERMINAL_JOB_STATUSES)[number])) {
			return job;
		}
		// Back off gently — a thermal label prints in seconds, but a queued job
		// waits for an offline agent to reconnect, and there is a shared rate limit.
		delayMs = Math.min(delayMs * 1.5, 10_000);
	}

	this.logger.warn(
		`LabelZoom print job ${jobId} did not reach a terminal state within ${timeoutSeconds}s (item ${itemIndex})`,
	);
	return { ...job, timedOut: true };
}

export async function print(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData> {
	const printerId = resourceId.call(this, 'printerId', itemIndex);
	const sourceFormat = this.getNodeParameter('sourceFormat', itemIndex, '') as string;
	const idempotencyKey = this.getNodeParameter('idempotencyKey', itemIndex, '') as string;
	const waitForCompletion = this.getNodeParameter('waitForCompletion', itemIndex, false) as boolean;
	const options = this.getNodeParameter('options', itemIndex, {}) as ConversionOptions;

	const document = await readDocument.call(this, itemIndex);

	// `sourceFormat` is the one query parameter the print endpoint consumes itself;
	// everything else is forwarded verbatim to the conversion step, which is why
	// rotation and DPI work here even when no format change happens.
	const query: Record<string, string> = {};
	if (sourceFormat !== '') query.sourceFormat = sourceFormat;

	const headers: Record<string, string> = {};
	if (idempotencyKey !== '') headers['Idempotency-Key'] = idempotencyKey;

	const response = await labelZoomRequest.call(this, {
		method: 'POST',
		path: `/api/v3/printers/${encodeURIComponent(printerId)}/print`,
		query: Object.keys(query).length > 0 ? query : undefined,
		params: serializeConversionParams(this.getNode(), options),
		body: document,
		contentType: sourceFormat === '' ? 'application/octet-stream' : sourceMediaType(sourceWireToken(sourceFormat)),
		headers,
	});

	const job = JSON.parse(response.body.toString('utf8')) as JsonObject;
	const json: IDataObject = {
		...job,
		printerId,
		requestId: requestIdOf(response),
	};

	if (waitForCompletion && typeof job.jobId === 'string') {
		const timeout = this.getNodeParameter('waitTimeout', itemIndex, 120) as number;
		const finished = await waitForJob.call(this, job.jobId, timeout, itemIndex);
		Object.assign(json, { job: finished, status: finished.status ?? json.status });
	}

	return { json, pairedItem: { item: itemIndex } };
}
