import type { INodeProperties } from 'n8n-workflow';

type ShowFor = { resource: string[]; operation: string[] };

/**
 * Printers and templates are referenced by UUID — there is no by-name lookup
 * endpoint — so a resourceLocator is the right control: "From List" resolves a
 * human name to an id at design time, and "By ID" keeps the field expressible for
 * workflows that carry the id in their data.
 */
export function printerLocator(showFor: ShowFor): INodeProperties {
	return {
		displayName: 'Printer',
		name: 'printerId',
		type: 'resourceLocator',
		default: { mode: 'list', value: '' },
		required: true,
		description: 'The cloud-connected printer to send the job to',
		displayOptions: { show: showFor },
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				typeOptions: { searchListMethod: 'getPrinters', searchable: true },
			},
			{
				displayName: 'By ID',
				name: 'id',
				type: 'string',
				placeholder: 'b2c3d4e5-...',
			},
		],
	};
}

export function templateLocator(showFor: ShowFor): INodeProperties {
	return {
		displayName: 'Template',
		name: 'templateId',
		type: 'resourceLocator',
		default: { mode: 'list', value: '' },
		required: true,
		description: 'A Print Template published from LabelZoom Studio',
		displayOptions: { show: showFor },
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				typeOptions: { searchListMethod: 'getTemplates', searchable: true },
			},
			{
				displayName: 'By ID',
				name: 'id',
				type: 'string',
				placeholder: 'a1b2c3d4-...',
			},
		],
	};
}

/**
 * Making a print safe to retry. The API treats a repeated Idempotency-Key as a
 * request for the original job rather than a second print, which is what you want
 * when n8n retries a step — a duplicate shipping label is a real cost.
 *
 * The default keys on execution id + item index, so a retried execution reprints
 * and a retried *step* does not. Override it with an order number when you have
 * one, so a workflow re-run for the same order is also safe.
 */
export function idempotencyKeyField(showFor: ShowFor): INodeProperties {
	return {
		displayName: 'Idempotency Key',
		name: 'idempotencyKey',
		type: 'string',
		default: '={{ $execution.id }}-{{ $itemIndex }}',
		description:
			'Repeating a key returns the original job instead of printing again. Set it from a stable business value (an order number) to make a whole workflow re-run safe.',
		displayOptions: { show: showFor },
	};
}

/** Statuses a job can reach; only `completed` means the label actually printed. */
export const TERMINAL_JOB_STATUSES = ['completed', 'failed'] as const;
