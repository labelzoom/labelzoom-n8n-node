/**
 * Coverage for the behavior that is specific to this node — the print surface,
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

import { LabelZoom } from '../nodes/LabelZoom/LabelZoom.node';
import codex from '../nodes/LabelZoom/LabelZoom.node.json';
import { convert } from '../nodes/LabelZoom/resources/label/convert';
import { getPrinters } from '../nodes/LabelZoom/listSearch/getPrinters';
import { getTemplates } from '../nodes/LabelZoom/listSearch/getTemplates';
import { print } from '../nodes/LabelZoom/resources/printer/print';
import { printTemplate } from '../nodes/LabelZoom/resources/printer/printTemplate';
import { isTextualTarget, TARGET_FORMATS } from '../nodes/LabelZoom/shared/formats';
import { LabelZoomValidationError } from '../nodes/LabelZoom/shared/validation';
import { makeHarness, type ScriptedResponse } from './helpers/harness';
import pkg from '../package.json';

const KEY = { apiKey: 'lz_live_' + 'a'.repeat(64) };
const JOB_ACCEPTED: ScriptedResponse = {
	status: 200,
	headers: { 'content-type': 'application/json' },
	bodyText: '{"jobId":"job-1","status":"dispatched"}',
};

describe('binary safety', () => {
	it('never exposes EPL, IPL, TSPL, DPL or SBPL output as decoded text', () => {
		// All five come back as text/plain but can inline raw bytes: EPL's GW and
		// TSPL's BITMAP embed a 1-bpp image payload, IPL frames commands in STX/ETX,
		// DPL output opens with STX, and SBPL prefixes every command with ESC.
		// Handing those to a downstream node as a string corrupts every label that
		// carries graphics.
		for (const format of ['epl', 'ipl', 'tspl', 'dpl', 'sbpl']) {
			expect(isTextualTarget(format), format).toBe(false);
		}
		// CPCL writes graphics as EG hex, so its output stays printable text.
		for (const format of ['zpl', 'cpcl', 'xml', 'json']) {
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

	it('sends several records as one batch with one key, and outputs the jobs', async () => {
		const { ctx, requests } = makeHarness({
			parameters: templateParameters({
				mergeData: '[{"orderNumber":"1001"},{"orderNumber":"1002"}]',
				idempotencyKey: 'SO-BATCH-1',
			}),
			credentials: KEY,
			responses: [
				{
					status: 202,
					headers: { 'content-type': 'application/json' },
					bodyText:
						'{"jobs":[{"jobId":"job-2","status":"queued"}],"remaining":1,"message":"Resubmit the remaining 1."}',
				},
			],
		});
		const result = await printTemplate.call(ctx, 0);

		expect(JSON.parse(requests[0].bodyText)).toEqual([{ orderNumber: '1001' }, { orderNumber: '1002' }]);
		// The server derives each entry's key from this one; the node must not.
		expect(requests[0].headers['idempotency-key']).toBe('SO-BATCH-1');
		expect(result.json).toEqual({
			jobs: [{ jobId: 'job-2', status: 'queued', copies: null, idempotent: false }],
			remaining: 1,
			message: 'Resubmit the remaining 1.',
			printerId: 'printer-1',
			templateId: 'template-1',
		});
	});

	it('sends a one-record array as that record, and outputs the job', async () => {
		const { ctx, requests } = makeHarness({
			parameters: templateParameters({ mergeData: '[{"orderNumber":"1001"}]' }),
			credentials: KEY,
			responses: [{ status: 202, headers: { 'content-type': 'application/json' }, bodyText: '{"jobId":"job-2","status":"queued"}' }],
		});
		const result = await printTemplate.call(ctx, 0);

		expect(JSON.parse(requests[0].bodyText)).toEqual({ orderNumber: '1001' });
		expect(result.json).toMatchObject({ jobId: 'job-2', copies: null, idempotent: false });
	});

	it('rejects a record that is not an object, before sending anything', async () => {
		const { ctx, requests } = makeHarness({
			parameters: templateParameters({ mergeData: '"1001"' }),
			credentials: KEY,
			responses: [],
		});
		await expect(printTemplate.call(ctx, 0)).rejects.toThrow(/must be a JSON object/);
		expect(requests).toHaveLength(0);
	});
});

describe('printer: idempotency key', () => {
	const parameters = (idempotencyKey: string) => ({
		printerId: { mode: 'id', value: 'printer-1' },
		sourceFormat: 'zpl',
		inputType: 'text',
		labelContent: '^XA^XZ',
		copies: 1,
		idempotencyKey,
		waitForCompletion: false,
		options: {},
	});

	it('generates a key when the field is empty, and reuses it on a retry', async () => {
		const { ctx, requests } = makeHarness({
			parameters: parameters(''),
			credentials: { ...KEY, maxRetries: 1 },
			responses: [{ status: 503, bodyText: 'Service Unavailable' }, JOB_ACCEPTED],
		});
		await print.call(ctx, 0);

		const keys = requests.map((request) => request.headers['idempotency-key']);
		expect(keys[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(keys[1]).toBe(keys[0]);
	});

	it('generates a fresh key for each item', async () => {
		const first = makeHarness({ parameters: parameters(''), credentials: KEY, responses: [JOB_ACCEPTED] });
		const second = makeHarness({ parameters: parameters(''), credentials: KEY, responses: [JOB_ACCEPTED] });
		await print.call(first.ctx, 0);
		await print.call(second.ctx, 0);

		expect(first.requests[0].headers['idempotency-key']).not.toBe(
			second.requests[0].headers['idempotency-key'],
		);
	});

	it('refuses a key that is only whitespace, because it is almost always an empty expression', async () => {
		const { ctx, requests } = makeHarness({ parameters: parameters('   '), credentials: KEY, responses: [] });
		await expect(print.call(ctx, 0)).rejects.toThrow(/Idempotency Key is blank/);
		expect(requests).toHaveLength(0);
	});
});

describe('printer: copies', () => {
	const jobResponse = (body: string): ScriptedResponse => ({
		status: 200,
		headers: { 'content-type': 'application/json' },
		bodyText: body,
	});

	// Both print operations take Copies the same way, so each case runs against
	// both. `baseSearch` is the exact query string each sends when Copies is left
	// alone — the request a workflow made before the field existed.
	const operations = [
		{
			name: 'Print',
			run: print,
			parameters: (overrides: Record<string, unknown> = {}) => ({
				printerId: { mode: 'list', value: 'printer-1' },
				sourceFormat: 'zpl',
				inputType: 'text',
				labelContent: '^XA^PQ3^XZ',
				idempotencyKey: '',
				waitForCompletion: false,
				options: {},
				...overrides,
			}),
			baseSearch: '?sourceFormat=zpl',
		},
		{
			name: 'Print Template',
			run: printTemplate,
			parameters: (overrides: Record<string, unknown> = {}) => ({
				printerId: { mode: 'list', value: 'printer-1' },
				templateId: { mode: 'list', value: 'template-1' },
				mergeData: '{"orderNumber":"1001"}',
				validate: true,
				idempotencyKey: '',
				...overrides,
			}),
			baseSearch: '?validate=true',
		},
	];

	describe.each(operations)('$name', ({ run, parameters, baseSearch }) => {
		it('sends copies when set', async () => {
			const { ctx, requests } = makeHarness({
				parameters: parameters({ copies: 5 }),
				credentials: KEY,
				responses: [jobResponse('{"jobId":"job-1","status":"dispatched","copies":5}')],
			});
			await run.call(ctx, 0);

			expect(requests).toHaveLength(1);
			expect(requests[0].url.searchParams.get('copies')).toBe('5');
		});

		it('sends copies mapped from an expression that resolved to a string', async () => {
			// `{{ $json.quantity }}` over a CSV or spreadsheet row resolves to "25", not 25.
			const { ctx, requests } = makeHarness({
				parameters: parameters({ copies: '25' }),
				credentials: KEY,
				responses: [jobResponse('{"jobId":"job-1","status":"dispatched","copies":25}')],
			});
			await run.call(ctx, 0);

			expect(requests[0].url.searchParams.get('copies')).toBe('25');
		});

		it.each([
			['left at its default of 1', { copies: 1 }],
			['set to the string "1"', { copies: '1' }],
			['absent from the parameters', {}],
		])(
			'omits copies when %s, leaving the request as it was before Copies existed',
			async (_label, overrides) => {
				const { ctx, requests } = makeHarness({
					parameters: parameters(overrides),
					credentials: KEY,
					responses: [jobResponse('{"jobId":"job-1","status":"dispatched","copies":null}')],
				});
				await run.call(ctx, 0);

				// The API treats copies=1 exactly like no parameter, so the default
				// must leave the request exactly as it was.
				expect(requests[0].url.searchParams.has('copies')).toBe(false);
				expect(requests[0].url.search).toBe(baseSearch);
			},
		);

		it.each([0, 10000, 2.5, -1, Number.NaN, 'abc', '', ' ', '2.5', '1e3', '-1', null])(
			'rejects copies = %o before sending anything',
			async (copies) => {
				const { ctx, requests } = makeHarness({
					parameters: parameters({ copies }),
					credentials: KEY,
					responses: [],
				});

				const error = await run.call(ctx, 0).then(
					() => undefined,
					(thrown: unknown) => thrown,
				);
				expect(error).toBeInstanceOf(LabelZoomValidationError);
				expect((error as LabelZoomValidationError).parameter).toBe('copies');
				expect((error as Error).message).toMatch(/copies must be a whole number from 1 to 9999/i);
				expect(requests).toHaveLength(0);
			},
		);

		it('surfaces the copies the job was accepted with', async () => {
			const { ctx } = makeHarness({
				parameters: parameters({ copies: 5 }),
				credentials: KEY,
				responses: [jobResponse('{"jobId":"job-1","status":"dispatched","copies":5}')],
			});
			const result = await run.call(ctx, 0);

			expect(result.json).toMatchObject({ jobId: 'job-1', printerId: 'printer-1', copies: 5 });
		});

		it('surfaces a null copies as-is, meaning Copies was not sent', async () => {
			const { ctx } = makeHarness({
				parameters: parameters(),
				credentials: KEY,
				responses: [jobResponse('{"jobId":"job-1","status":"dispatched","copies":null}')],
			});
			const result = await run.call(ctx, 0);

			expect(result.json.copies).toBeNull();
		});
	});

	it('sends no query string at all from Print Template when nothing is set', async () => {
		const { ctx, requests } = makeHarness({
			parameters: operations[1].parameters({ validate: false }),
			credentials: KEY,
			responses: [jobResponse('{"jobId":"job-1","status":"queued"}')],
		});
		await printTemplate.call(ctx, 0);

		expect(requests[0].url.search).toBe('');
	});

	it('sends copies alone from Print Template when validation is off', async () => {
		const { ctx, requests } = makeHarness({
			parameters: operations[1].parameters({ validate: false, copies: 3 }),
			credentials: KEY,
			responses: [jobResponse('{"jobId":"job-1","status":"queued","copies":3}')],
		});
		await printTemplate.call(ctx, 0);

		expect(requests[0].url.search).toBe('?copies=3');
	});

	it('sends copies alongside sourceFormat and the transform options on Print', async () => {
		const { ctx, requests } = makeHarness({
			parameters: operations[0].parameters({ copies: 12, options: { rotation: 90 } }),
			credentials: KEY,
			responses: [jobResponse('{"jobId":"job-1","status":"dispatched","copies":12}')],
		});
		await print.call(ctx, 0);

		const { searchParams } = requests[0].url;
		expect(searchParams.get('sourceFormat')).toBe('zpl');
		expect(searchParams.get('copies')).toBe('12');
		// Copies is a print-endpoint parameter, not a conversion option.
		expect(JSON.parse(searchParams.get('params') as string)).toEqual({ rotation: 90 });
	});
});

describe('node versions', () => {
	const description = new LabelZoom().description;
	const conversionOptions = (operation: string) =>
		(
			description.properties.find(
				(p) => p.name === 'options' && p.displayOptions?.show?.operation?.includes(operation),
			)?.options ?? []
		) as Array<{ name: string; displayOptions?: { show?: Record<string, unknown> } }>;

	it('adds version 2 and makes it the default for new nodes', () => {
		expect(description.version).toEqual([1, 2]);
		expect(description.defaultVersion).toBe(2);
	});

	it('offers DPI on version 1 only, and Source DPI and Target DPI on version 2', () => {
		for (const operation of ['convert', 'print']) {
			const byName = new Map(conversionOptions(operation).map((o) => [o.name, o]));
			expect(byName.get('dpi')?.displayOptions?.show?.['@version']).toEqual([1]);
			for (const name of ['sourceDpi', 'targetDpi']) {
				expect(byName.get(name)?.displayOptions?.show?.['@version'], `${operation} ${name}`).toEqual([
					{ _cnd: { gte: 2 } },
				]);
			}
		}
	});

	it('still sends a saved version 1 workflow’s DPI exactly as before', async () => {
		const { ctx, requests } = makeHarness({
			parameters: {
				sourceFormat: 'pdf',
				targetFormat: 'zpl',
				inputType: 'text',
				labelContent: '%PDF-1.4',
				outputBinaryPropertyName: 'data',
				options: { dpi: 300 },
			},
			responses: [{ status: 200, headers: { 'content-type': 'text/plain' }, bodyText: '^XA^XZ' }],
		});
		await convert.call(ctx, 0);

		expect(JSON.parse(requests[0].url.searchParams.get('params') as string)).toEqual({ dpi: 300 });
	});
});

describe('formats', () => {
	it('lists every source and target the API converts', () => {
		const properties = new LabelZoom().description.properties;
		const values = (name: string, operation: string) =>
			(
				properties.find(
					(p) => p.name === name && p.displayOptions?.show?.operation?.includes(operation),
				)?.options as Array<{ value: string }>
			).map((o) => o.value);

		for (const format of ['esclabel', 'fingerprint', 'ezpl', 'cpcl', 'tpcl', 'nlbl', 'lbl', 'btw', 'dymo']) {
			expect(values('sourceFormat', 'convert'), format).toContain(format);
			expect(values('sourceFormat', 'print'), format).toContain(format);
		}
		expect(values('targetFormat', 'convert')).toContain('cpcl');
		// A URL can be converted, never printed.
		expect(values('sourceFormat', 'convert')).toContain('url');
		expect(values('sourceFormat', 'print')).not.toContain('url');
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

	it('refuses base64 input before sending anything', async () => {
		// Print reads the body as the file itself, under the source format's own
		// media type, so a base64 string reaches the printer as base64 characters.
		// A workflow saved while the mode was offered still lands here.
		const { ctx, requests } = makeHarness({
			parameters: { ...base, sourceFormat: 'pdf', inputType: 'base64', labelContent: 'JVBERi0xLjQK' },
			credentials: KEY,
			responses: [JOB_ACCEPTED],
		});
		await expect(print.call(ctx, 0)).rejects.toThrow(/Base64 text cannot be printed/);
		expect(requests).toHaveLength(0);
	});

	it('no longer offers base64 input, while Convert still does', () => {
		const properties = new LabelZoom().description.properties;
		const inputTypes = (operation: string) =>
			(
				properties.find(
					(p) => p.name === 'inputType' && p.displayOptions?.show?.operation?.includes(operation),
				)?.options as Array<{ value: string }>
			).map((o) => o.value);

		expect(inputTypes('print')).not.toContain('base64');
		expect(inputTypes('convert')).toContain('base64');
	});

	it('sends a design file as raw bytes under application/octet-stream', async () => {
		const bytes = Buffer.from([0x00, 0xff, 0x42, 0x54, 0xc3]);
		const { ctx, requests, } = makeHarness({
			parameters: { ...base, sourceFormat: 'btw', inputType: 'binary', binaryPropertyName: 'data' },
			credentials: KEY,
			binary: { data: { data: bytes } },
			responses: [JOB_ACCEPTED],
		});
		await print.call(ctx, 0);

		expect(requests[0].headers['content-type']).toBe('application/octet-stream');
		expect(requests[0].url.searchParams.get('sourceFormat')).toBe('btw');
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

describe('credential declaration', () => {
	// n8n resolves a node's credential with `.find(c => c.name === type)` and then
	// requires THAT entry's displayOptions to match the current parameters, or it
	// throws "Credentials not found". So a second declaration of the same name is
	// dead weight at best, and at worst — as shipped in 0.1.0 — scopes the only
	// consulted entry to one operation and silently breaks every other one.
	it('declares each credential name exactly once', () => {
		const names = new LabelZoom().description.credentials?.map((c) => c.name) ?? [];
		expect(names).toEqual([...new Set(names)]);
	});

	// A displayOptions gate on the single entry is the same bug by another route:
	// it makes the credential unresolvable everywhere the gate does not match.
	it('puts no displayOptions on the single credential entry', () => {
		for (const credential of new LabelZoom().description.credentials ?? []) {
			expect(credential.displayOptions, credential.name).toBeUndefined();
		}
	});
});

describe('codex', () => {
	// The codex `node` field must be `<npm package name>.<node name>`. The scaffold
	// default is `n8n-nodes-base.<name>` — the namespace reserved for nodes bundled
	// in n8n core — and shipping that is what n8n's verification review rejected
	// 0.1.2 for. Nothing else catches it: the strict-mode linter passes on it, and
	// the release workflow only checks the file is present in the tarball.
	//
	// Derived from package.json and the node description rather than hard-coded, so
	// renaming either side without the other fails here.
	it('gives the codex a node type matching the package name', () => {
		expect(codex.node).toBe(`${pkg.name}.${new LabelZoom().description.name}`);
	});
});

describe('missing credential', () => {
	const printParams = {
		printerId: { mode: 'list', value: 'printer-1' },
		sourceFormat: 'zpl',
		inputType: 'text',
		labelContent: '^XA^XZ',
		idempotencyKey: '',
		waitForCompletion: false,
		options: {},
	};

	it('explains that Print needs a key, rather than sending an anonymous request', async () => {
		// The failure this replaces: the request went out unauthenticated and the
		// user saw a bare "401 Unauthorized" from the server for what was actually a
		// missing local setting.
		const { ctx, requests } = makeHarness({ parameters: printParams, responses: [] });

		await expect(print.call(ctx, 0)).rejects.toThrow(/needs a LabelZoom API key/);
		expect(requests, 'must not reach the network').toHaveLength(0);
	});

	it('explains that the printer dropdown needs a key', async () => {
		const { ctx, requests } = makeHarness({ responses: [] });

		await expect(getPrinters.call(ctx)).rejects.toThrow(/needs a LabelZoom API key/);
		expect(requests).toHaveLength(0);
	});

	it('still lets plain Convert run anonymously', async () => {
		// The free tier is a real feature: no credential, watermarked output.
		const { ctx, requests } = makeHarness({
			parameters: {
				sourceFormat: 'zpl',
				targetFormat: 'pdf',
				inputType: 'text',
				labelContent: '^XA^XZ',
				outputBinaryPropertyName: 'data',
				options: {},
			},
			responses: [{ status: 200, headers: { 'content-type': 'application/pdf' }, bodyText: '%PDF-1.4' }],
		});

		await convert.call(ctx, 0);
		expect(requests[0].headers.authorization, 'anonymous means no header at all').toBeUndefined();
	});
});
