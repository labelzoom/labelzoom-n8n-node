import type { IExecuteFunctions, INodeExecutionData, INodeProperties, JsonObject } from 'n8n-workflow';

import { labelZoomJsonRequest } from '../../shared/transport';
import { resourceId } from '../../shared/utils';
import { LabelZoomValidationError } from '../../shared/validation';
import { printerLocator } from './shared';

const getJobShowFor = { resource: ['printer'], operation: ['getJob'] };
const getStatusShowFor = { resource: ['printer'], operation: ['getStatus'] };

export const readsDescription: INodeProperties[] = [
	{
		displayName: 'Job ID',
		name: 'jobId',
		type: 'string',
		default: '',
		required: true,
		description: 'The jobId returned by a Print operation',
		displayOptions: { show: getJobShowFor },
	},
	printerLocator(getStatusShowFor),
];

/** GET /api/v3/printers — every printer on the account, with its live status. */
export async function getMany(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const response = await labelZoomJsonRequest.call(this, 'GET', '/api/v3/printers');
	const printers = Array.isArray(response.printers) ? (response.printers as JsonObject[]) : [];
	return printers.map((printer) => ({ json: printer, pairedItem: { item: itemIndex } }));
}

/** GET /api/v3/jobs/:id — poll a print job you already submitted. */
export async function getJob(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData> {
	const jobId = String(this.getNodeParameter('jobId', itemIndex) ?? '').trim();
	if (jobId === '') {
		throw new LabelZoomValidationError(this.getNode(), 'jobId', 'No Job ID was provided', {
			itemIndex,
		});
	}
	const job = await labelZoomJsonRequest.call(this, 'GET', `/api/v3/jobs/${encodeURIComponent(jobId)}`);
	return { json: job, pairedItem: { item: itemIndex } };
}

/**
 * GET /api/v3/print/quota — how many agents, printers and jobs the plan allows,
 * how many are used, and when today's job count resets.
 */
export async function getQuota(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData> {
	const quota = await labelZoomJsonRequest.call(this, 'GET', '/api/v3/print/quota');
	return { json: quota, pairedItem: { item: itemIndex } };
}

/** GET /api/v3/printers/:id/status — is this printer ready, out of paper, offline? */
export async function getStatus(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData> {
	const printerId = resourceId.call(this, 'printerId', itemIndex);
	const status = await labelZoomJsonRequest.call(
		this,
		'GET',
		`/api/v3/printers/${encodeURIComponent(printerId)}/status`,
	);
	return { json: status, pairedItem: { item: itemIndex } };
}
