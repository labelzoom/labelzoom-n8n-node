/**
 * Coverage for the behaviour that is specific to this node — the print surface,
 * the dropdowns, and the binary-safety rules. The shared wire contract is
 * asserted separately by conformance.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

const sleeps: number[] = [];
vi.mock('n8n-workflow', async (importOriginal) => {
	const actual = await importOriginal<typeof import('n8n-workflow')>();
	return {
		...actual,
		sleep: async (ms: number) => {
			sleeps.push(ms);
		},
	};
});

import { convert } from '../nodes/LabelZoom/resources/label/convert';
import { getPrinters } from '../nodes/LabelZoom/listSearch/getPrinters';
import { getTemplates } from '../nodes/LabelZoom/listSearch/getTemplates';
import { print } from '../nodes/LabelZoom/resources/printer/print';
import { printTemplate } from '../nodes/LabelZoom/resources/printer/printTemplate';
import { isTextualTarget, TARGET_FORMATS } from '../nodes/LabelZoom/shared/formats';
import { makeHarness, type ScriptedResponse } from './helpers/harness';

const KEY = { apiKey: 'lz_live_' + 'a'.repeat(64) };
const JOB_ACCEPTED: ScriptedResponse = {
	status: 200,
	headers: { 'content-type': 'application/json' },
	bodyText: '{"jobId":"job-1","status":"dispatched"}',
};

describe('binary safety', () => {
	it('never exposes EPL, TSPL or DPL output as decoded text', () => {
		// All three come back as text/plain but can inline raw bytes: EPL's GW and
		// TSPL's BITMAP embed a 1-bpp image payload, and DPL output opens with STX.
		// Handing those to a downstream node as a string corrupts every label that
		// carries graphics.
		for (const format of ['epl', 'tspl', 'dpl']) {
			expect(isTextualTarget(format), format).toBe(false);
		}
		for (const format of ['zpl', 'xml', 'json']) {
			expect(isTextualTarget(format), format).toBe(true);
		}
	});

	it('offers no source-only format as a conversion target', () => {
		expect(TARGET_FORMATS as readonly string[]).not.toContain('url');
		expect(TARGET_FORMATS as readonly string[]).not.toContain('jpg');
	});

	it('returns EPL as binary with no text field', async () => {
		const { ctx } = makeHarness({
			parameters: {
				sourceFormat: 'zpl',
				targetFormat: 'epl',
				inputType: 'text',
				labelContent: '^XA^XZ',
				outputBinaryPropertyName: 'data',
				options: {},
			},
			responses: [{ status: 200, headers: { 'content-type': 'text/plain' }, bodyText: 'N\nGW0,0,1,1,\xff' }],
		});
		const result = await convert.call(ctx, 0);
		expect(result.json.text).toBeUndefined();
		expect(result.binary?.data).toBeDefined();
	});
});

describe('user agent', () => {
	it('identifies the node and never impersonates LabelZoom Studio', async () => {
		const { ctx, requests } = makeHarness({
			parameters: {
				sourceFormat: 'zpl',
				targetFormat: 'zpl',
				inputType: 'text',
				labelContent: '^XA^XZ',
				outputBinaryPropertyName: 'data',
				options: {},
			},
			responses: [{ status: 200, headers: { 'content-type': 'text/plain' }, bodyText: '^XA^XZ' }],
		});
		await convert.call(ctx, 0);

		const userAgent = requests[0].headers['user-agent'];
		expect(userAgent).toContain('labelzoom-n8n-node');
		// The server parses a `LabelZoomStudio/` prefix and silently forces
		// pdf.conversionMode = NATIVE for versions <= 1.8.2.
		expect(userAgent.startsWith('LabelZoomStudio/')).toBe(false);
	});
});

describe('printer: print', () => {
	const printParameters = (overrides: Record<string, unknown> = {}) => ({
		printerId: { mode: 'list', value: 'printer-1' },
		sourceFormat: 'zpl',
		inputType: 'text',
		labelContent: '^XA^XZ',
		idempotencyKey: 'order-1001',
		waitForCompletion: false,
		options: {},
		...overrides,
	});

	it('sends the raw document with the declared source format and idempotency key', async () => {
		const { ctx, requests } = makeHarness({
			parameters: printParameters(),
			credentials: KEY,
			responses: [JOB_ACCEPTED],
		});
		const result = await print.call(ctx, 0);

		expect(requests[0].method).toBe('POST');
		expect(requests[0].url.pathname).toBe('/api/v3/printers/printer-1/print');
		expect(requests[0].url.searchParams.get('sourceFormat')).toBe('zpl');
		expect(requests[0].headers['content-type']).toBe('text/plain');
		expect(requests[0].headers['idempotency-key']).toBe('order-1001');
		expect(requests[0].bodyText).toBe('^XA^XZ');
		expect(result.json).toMatchObject({ jobId: 'job-1', status: 'dispatched', printerId: 'printer-1' });
	});

	it('forwards transform options as the params JSON, alongside sourceFormat', async () => {
		const { ctx, requests } = makeHarness({
			parameters: printParameters({ options: { rotation: 90, dpi: 300 } }),
			credentials: KEY,
			responses: [JOB_ACCEPTED],
		});
		await print.call(ctx, 0);

		// sourceFormat is consumed by the print endpoint; everything else is handed
		// to the conversion step that runs on the way to the printer.
		expect(requests[0].url.searchParams.get('sourceFormat')).toBe('zpl');
		expect(JSON.parse(requests[0].url.searchParams.get('params') as string)).toEqual({
			rotation: 90,
			dpi: 300,
		});
	});

	it('omits sourceFormat when auto-detecting', async () => {
		const { ctx, requests } = makeHarness({
			parameters: printParameters({ sourceFormat: '' }),
			credentials: KEY,
			responses: [JOB_ACCEPTED],
		});
		await print.call(ctx, 0);

		expect(requests[0].url.searchParams.get('sourceFormat')).toBeNull();
		expect(requests[0].headers['content-type']).toBe('application/octet-stream');
	});

	it('polls the job to a terminal state when asked to wait', async () => {
		const { ctx, requests } = makeHarness({
			parameters: printParameters({ waitForCompletion: true, waitTimeout: 30 }),
			credentials: KEY,
			responses: [
				JOB_ACCEPTED,
				{ status: 200, headers: { 'content-type': 'application/json' }, bodyText: '{"id":"job-1","status":"printing"}' },
				{ status: 200, headers: { 'content-type': 'application/json' }, bodyText: '{"id":"job-1","status":"completed"}' },
			],
		});
		const result = await print.call(ctx, 0);

		expect(requests.map((r) => r.url.pathname)).toEqual([
			'/api/v3/printers/printer-1/print',
			'/api/v3/jobs/job-1',
			'/api/v3/jobs/job-1',
		]);
		// "dispatched" only means accepted; the reported status is the terminal one.
		expect(result.json.status).toBe('completed');
	});
});

describe('printer: print template', () => {
	const templateParameters = (overrides: Record<string, unknown> = {}) => ({
		printerId: { mode: 'list', value: 'printer-1' },
		templateId: { mode: 'list', value: 'template-1' },
		mergeData: '{"orderNumber":"1001"}',
		validate: true,
		idempotencyKey: '',
		...overrides,
	});

	it('posts merge data as JSON and asks the server to validate it', async () => {
		const { ctx, requests } = makeHarness({
			parameters: templateParameters(),
			credentials: KEY,
			responses: [{ status: 202, headers: { 'content-type': 'application/json' }, bodyText: '{"jobId":"job-2","status":"queued"}' }],
		});
		const result = await printTemplate.call(ctx, 0);

		expect(requests[0].url.pathname).toBe('/api/v3/printers/printer-1/templates/template-1/print');
		expect(requests[0].url.searchParams.get('validate')).toBe('true');
		expect(requests[0].headers['content-type']).toBe('application/json');
		expect(JSON.parse(requests[0].bodyText)).toEqual({ orderNumber: '1001' });
		expect(result.json).toMatchObject({ jobId: 'job-2', templateId: 'template-1' });
	});

	it('rejects an array, because the response shape would change with it', async () => {
		const { ctx, requests } = makeHarness({
			parameters: templateParameters({ mergeData: '[{"orderNumber":"1001"}]' }),
			credentials: KEY,
			responses: [],
		});
		await expect(printTemplate.call(ctx, 0)).rejects.toThrow(/single JSON object/);
		expect(requests).toHaveLength(0);
	});
});

describe('dropdowns', () => {
	it('labels printers with their native format and status', async () => {
		const { ctx } = makeHarness({
			credentials: KEY,
			responses: [
				{
					status: 200,
					headers: { 'content-type': 'application/json' },
					bodyText: JSON.stringify({
						printers: [
							{ id: 'p2', name: 'Back Office', status: 'offline', config: { nativeFormat: 'epl' } },
							{ id: 'p1', name: 'Warehouse Zebra', status: 'ready', config: { nativeFormat: 'zpl' } },
						],
					}),
				},
			],
		});
		const { results } = await getPrinters.call(ctx);

		expect(results).toEqual([
			{ name: 'Back Office — EPL (offline)', value: 'p2' },
			{ name: 'Warehouse Zebra — ZPL (ready)', value: 'p1' },
		]);
	});

	it('shows a template’s merge fields in the picker', async () => {
		const { ctx } = makeHarness({
			credentials: KEY,
			responses: [
				{
					status: 200,
					headers: { 'content-type': 'application/json' },
					bodyText: JSON.stringify({
						templates: [{ id: 't1', name: 'Shipping Label', merge_fields: ['orderNumber', 'sku'] }],
					}),
				},
			],
		});
		const { results } = await getTemplates.call(ctx);

		expect(results).toEqual([
			{ name: 'Shipping Label — orderNumber, sku', value: 't1' },
		]);
	});

	it('filters the printer list by the search term', async () => {
		const printers = {
			printers: [
				{ id: 'p1', name: 'Warehouse Zebra', status: 'ready', config: { nativeFormat: 'zpl' } },
				{ id: 'p2', name: 'Back Office', status: 'ready', config: { nativeFormat: 'zpl' } },
			],
		};
		const { ctx } = makeHarness({
			credentials: KEY,
			responses: [{ status: 200, headers: { 'content-type': 'application/json' }, bodyText: JSON.stringify(printers) }],
		});
		const { results } = await getPrinters.call(ctx, 'warehouse');

		expect(results).toHaveLength(1);
		expect(results[0].value).toBe('p1');
	});
});

describe('errors', () => {
	it('surfaces the request id and the missing scope on a 403', async () => {
		const { ctx } = makeHarness({
			parameters: {
				printerId: { mode: 'list', value: 'printer-1' },
				sourceFormat: 'zpl',
				inputType: 'text',
				labelContent: '^XA^XZ',
				idempotencyKey: '',
				waitForCompletion: false,
				options: {},
			},
			credentials: { ...KEY, maxRetries: 0 },
			responses: [
				{
					status: 403,
					headers: { 'content-type': 'application/json', 'x-lz-request-id': 'req-42' },
					bodyText: '{"message":"This API key lacks the \\"print\\" scope"}',
				},
			],
		});

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const error: any = await print.call(ctx, 0).then(
			() => {
				throw new Error('expected a rejection');
			},
			(e) => e,
		);

		expect(error.message).toBe('This API key lacks the "print" scope');
		expect(error.description).toContain('required scope');
		expect(error.description).toContain('req-42');
	});

	it('does not retry an auth failure', async () => {
		// Repeated auth failures are rate limited by source IP, so a retrying bad
		// credential would take down every workflow sharing that address.
		const { ctx, requests } = makeHarness({
			parameters: {
				sourceFormat: 'zpl',
				targetFormat: 'zpl',
				inputType: 'text',
				labelContent: '^XA^XZ',
				outputBinaryPropertyName: 'data',
				options: {},
			},
			credentials: { apiKey: 'lz_live_bad' },
			responses: [{ status: 401, headers: {}, bodyText: '{"message":"Unauthorized"}' }],
		});

		await expect(convert.call(ctx, 0)).rejects.toThrow(/Unauthorized/);
		expect(requests).toHaveLength(1);
	});
});

describe('print input modes', () => {
	const base = {
		printerId: { mode: 'list', value: 'printer-1' },
		idempotencyKey: '',
		waitForCompletion: false,
		options: {},
	};

	it('sends base64 input as text/plain, not the source format’s media type', async () => {
		// The Print operation offers the same "Base64 Text" mode as Convert. Sending
		// a base64 string labelled application/pdf produces a 502 on the way to the
		// printer, or garbage at the printer itself.
		const { ctx, requests } = makeHarness({
			parameters: { ...base, sourceFormat: 'pdf', inputType: 'base64', labelContent: 'JVBERi0xLjQK' },
			credentials: KEY,
			responses: [JOB_ACCEPTED],
		});
		await print.call(ctx, 0);

		expect(requests[0].headers['content-type']).toBe('text/plain');
		expect(requests[0].bodyText).toBe('JVBERi0xLjQK');
	});

	it('still sends the source format’s media type for a real file', async () => {
		const { ctx, requests } = makeHarness({
			parameters: { ...base, sourceFormat: 'pdf', inputType: 'binary', binaryPropertyName: 'data' },
			credentials: KEY,
			binary: { data: { data: Buffer.from('%PDF-1.4') } },
			responses: [JOB_ACCEPTED],
		});
		await print.call(ctx, 0);

		expect(requests[0].headers['content-type']).toBe('application/pdf');
	});

	it('explains a non-JSON 2xx instead of leaking a SyntaxError', async () => {
		const { ctx } = makeHarness({
			parameters: { ...base, sourceFormat: 'zpl', inputType: 'text', labelContent: '^XA^XZ' },
			credentials: KEY,
			responses: [{ status: 200, headers: { 'content-type': 'text/html' }, bodyText: '<html>captive portal</html>' }],
		});

		await expect(print.call(ctx, 0)).rejects.toThrow(/Expected a print job from LabelZoom/);
	});
});
