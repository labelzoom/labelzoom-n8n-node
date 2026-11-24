import type { IExecuteFunctions, INodeProperties, JsonObject } from 'n8n-workflow';

import { LabelZoomValidationError } from '../../shared/validation';

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
 * Making a print safe to retry. The API treats a repeated Idempotency-Key (with the
 * same request) as a request for the original job rather than a second print, which is what you want
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
			'Repeating a key with the same request returns the original job instead of printing again; reusing it for a different document, merge data or Copies is rejected. Set it from a stable business value (an order number) to make a whole workflow re-run safe. Leave it empty to have the node generate a key for each print.',
		displayOptions: { show: showFor },
	};
}

/**
 * Read the Idempotency-Key to send (rule P4).
 *
 * Every print carries one. A key the user sets is sent exactly as given, and one
 * that is only whitespace is refused rather than silently replaced: it is almost
 * always an expression that resolved to nothing. An empty field gets a random
 * UUID v4, made once per item, so the transport's retries of this call reuse it
 * and a retry after a lost response returns the original job instead of printing
 * twice.
 */
export function readIdempotencyKey(this: IExecuteFunctions, itemIndex: number): string {
	const raw: unknown = this.getNodeParameter('idempotencyKey', itemIndex, '');
	const key = raw === undefined || raw === null ? '' : String(raw);
	if (key === '') return crypto.randomUUID();
	if (key.trim() === '') {
		throw new LabelZoomValidationError(
			this.getNode(),
			'idempotencyKey',
			'Idempotency Key is blank',
			{
				itemIndex,
				description:
					'Set it from a stable value such as an order number, or clear the field to have the node generate one for each print.',
			},
		);
	}
	return key;
}

/**
 * Fill in what a print job response may omit (rule P6): `copies` is null when it
 * wasn't set, and `idempotent` is false unless the server replayed the job. The
 * status is kept as the server's string, so a status added later still passes
 * through.
 */
export function normalizePrintJob(job: JsonObject): JsonObject {
	return { ...job, copies: job.copies ?? null, idempotent: job.idempotent === true };
}

/** The API accepts `copies` from 1 to this, inclusive. */
export const MAX_COPIES = 9999;

/**
 * How many times the job is sent to the printer.
 *
 * Any quantity the document or template already carries multiplies with it, and a
 * document holding several labels prints collated (A, B, A, B). 1 is never sent:
 * the API treats it exactly like leaving the parameter off, and leaving it off
 * keeps a workflow that never touches this field sending the very request it sent
 * before the field existed.
 */
export function copiesField(showFor: ShowFor): INodeProperties {
	return {
		displayName: 'Copies',
		name: 'copies',
		type: 'number',
		typeOptions: { minValue: 1, maxValue: MAX_COPIES, numberPrecision: 0 },
		default: 1,
		description:
			"How many times to send the job to the printer, from 1 to 9999. A quantity already set in the document or template multiplies: a label carrying ^PQ3 with Copies set to 5 prints 15. Leave it at 1 to print it once, as sent.",
		displayOptions: { show: showFor },
	};
}

/**
 * Read and validate Copies before anything is sent.
 *
 * The field is usually mapped from the incoming item (`{{ $json.quantity }}`), and
 * an expression can resolve to a string — a quantity read from CSV or a
 * spreadsheet arrives as `"25"`, not 25 — so a string of digits is accepted. What
 * is rejected mirrors the API's own rule (decimal digits, 1 to 9999), so a value
 * the server would 400 on costs no request.
 */
export function readCopies(this: IExecuteFunctions, itemIndex: number): number {
	const raw: unknown = this.getNodeParameter('copies', itemIndex, 1);

	let copies = Number.NaN;
	if (typeof raw === 'number') {
		copies = raw;
	} else if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
		copies = Number(raw.trim());
	}

	if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIES) {
		const received = typeof raw === 'number' ? String(raw) : JSON.stringify(raw);
		throw new LabelZoomValidationError(
			this.getNode(),
			'copies',
			`Copies must be a whole number from 1 to ${MAX_COPIES}, got ${received}`,
			{
				itemIndex,
				description:
					"Set Copies to how many times the job should be sent to the printer, or leave it at 1 to print it once, as sent.",
			},
		);
	}

	return copies;
}

/** Statuses a job can reach; only `completed` means the label actually printed. */
export const TERMINAL_JOB_STATUSES = ['completed', 'failed'] as const;
