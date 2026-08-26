/**
 * Runs the shared LabelZoom conformance fixtures against this node.
 *
 * The node cannot depend on `@labelzoom/sdk` — n8n verification forbids runtime
 * dependencies — so it re-implements the wire contract by hand. These are the
 * same 83 fixtures the eight language SDKs run, and they are the only thing
 * stopping the two implementations from drifting apart.
 *
 * Entirely offline: the HTTP helper is a recording stub, so this passes on a fork
 * pull request with no secrets.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import skipsFile from './conformance-skips.json';
import spec from './conformance/spec.json';

// n8n's `sleep` is the retry backoff seam. Mocking it keeps the retry fixtures
// instant and lets them assert the exact delays the contract specifies.
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
import { TARGET_FORMATS } from '../nodes/LabelZoom/shared/formats';
import { LabelZoomValidationError } from '../nodes/LabelZoom/shared/validation';
import { makeHarness, type ScriptedResponse } from './helpers/harness';

// Fixtures are pulled in by the bundler rather than read off disk: an n8n
// community node may not import node:fs, and while that restriction is really
// about shipped code, the linter is not configurable under strict mode. Loading
// them this way keeps the default config intact and costs nothing.
const caseModules = import.meta.glob('./conformance/cases/**/*.json', { eager: true }) as Record<
	string,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	{ default: any }
>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fixture(caseId: string): any {
	const key = `./conformance/cases/${caseId}.json`;
	const module = caseModules[key];
	if (module === undefined) throw new Error(`Fixture ${key} is missing. Run: npm run sync-conformance`);
	return module.default;
}

const allCaseIds: string[] = spec.cases;
const skips: Record<string, string> = Object.fromEntries(
	skipsFile.skips.map((s: { id: string; reason: string }) => [s.id, s.reason]),
);
const expectedCaseIds = allCaseIds.filter((id) => !(id in skips));

const OK_RESPONSE: ScriptedResponse = {
	status: 200,
	headers: { 'content-type': 'text/plain' },
	bodyText: '^XA^XZ',
};

/**
 * Translate a fixture's wire-shaped call into this node's parameters.
 *
 * This function is the entire per-implementation surface of the suite — the
 * fixtures themselves are language-neutral, and everything else below is shared
 * assertion logic.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function nodeParameters(given: any): Record<string, unknown> {
	const options: Record<string, unknown> = {};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	for (const [key, value] of Object.entries((given.options ?? {}) as Record<string, any>)) {
		switch (key) {
			case 'dpi':
			case 'rotation':
			case 'scaling':
			case 'colorMode':
			case 'darkness':
			case 'watermark':
			case 'dialect':
				options[key] = value;
				break;
			case 'position':
				options.positionX = value.x;
				options.positionY = value.y;
				break;
			case 'label':
				if (value.width !== undefined) options.labelWidth = value.width;
				if (value.height !== undefined) options.labelHeight = value.height;
				break;
			case 'pdf':
				if (value.conversionMode !== undefined) options.pdfConversionMode = value.conversionMode;
				if (value.pageNumber !== undefined) options.pdfPageNumber = value.pageNumber;
				break;
			case 'zpl':
				if (value.commandsToIgnore !== undefined) {
					options.zplCommandsToIgnore = (value.commandsToIgnore as string[]).join(',');
				}
				if (value.imageCompression !== undefined) options.zplImageCompression = value.imageCompression;
				break;
			case 'data':
				options.data = JSON.stringify(value);
				break;
			default:
				throw new Error(
					`Fixture sets option '${key}', which this runner does not map. ` +
						'Add it to nodeParameters rather than skipping the case.',
				);
		}
	}

	// response/* and retry/* fixtures describe what comes *back*, so they carry no
	// source, target or body. The SDK runners hardcode a zpl→zpl call for those;
	// same default here so every runner exercises the same request.
	return {
		sourceFormat: given.source ?? 'zpl',
		targetFormat: given.target ?? 'zpl',
		inputType: given.sourceEncoding === 'base64text' ? 'base64' : 'text',
		// `bodyText` means the REQUEST body in a request/* fixture and the RESPONSE
		// body in a response/* one. `source` is the discriminator: only request-side
		// fixtures declare it.
		labelContent: given.source === undefined ? '^XA^XZ' : (given.bodyText ?? ''),
		outputBinaryPropertyName: 'data',
		options,
	};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function harnessFor(given: any, responses: ScriptedResponse[], maxRetries?: number) {
	// `apiKey: null` in a fixture means "no credential". `client` absent entirely
	// also means anonymous here: unlike an SDK, an n8n node has no environment
	// variable to fall back to — a credential is the only source of a key.
	const client = given.client ?? {};
	const hasCredential = 'apiKey' in client || 'baseUrl' in client || maxRetries !== undefined;

	return makeHarness({
		parameters: nodeParameters(given),
		responses,
		credentials: hasCredential
			? {
					apiKey: client.apiKey ?? '',
					baseUrl: client.baseUrl,
					maxRetries: maxRetries ?? given.maxRetries,
				}
			: undefined,
	});
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runRequestCase(given: any, expected: any): Promise<void> {
	const { ctx, requests } = harnessFor(given, [OK_RESPONSE]);
	await convert.call(ctx, 0);

	const request = requests[requests.length - 1];

	if (expected.method !== undefined) expect(request.method).toBe(expected.method);
	if (expected.url !== undefined) expect(request.url.origin + request.url.pathname).toBe(expected.url);
	if (expected.path !== undefined) expect(request.url.pathname).toBe(expected.path);

	for (const [name, value] of Object.entries(expected.headers ?? {})) {
		expect(request.headers[name.toLowerCase()], `header ${name}`).toBe(value);
	}
	for (const name of expected.headersAbsent ?? []) {
		expect(request.headers[name.toLowerCase()], `header ${name} must be absent`).toBeUndefined();
	}
	for (const [name, pattern] of Object.entries(expected.headersMatch ?? {})) {
		if (name.toLowerCase() === 'user-agent') {
			// Documented deviation. The fixture pins `^labelzoom-[a-z0-9]+-sdk/`,
			// which is the SDK family's naming. This is an n8n node, not an SDK, and
			// calling it one in the User-Agent would misreport what is on the wire.
			// The substance of rule B4 — identify the client, and never impersonate
			// LabelZoomStudio, whose prefix the server special-cases — is asserted
			// directly in transport.test.ts instead.
			continue;
		}
		expect(request.headers[name.toLowerCase()] ?? '').toMatch(new RegExp(pattern as string));
	}
	for (const [name, pattern] of Object.entries(expected.headersNotMatch ?? {})) {
		expect(request.headers[name.toLowerCase()] ?? '').not.toMatch(new RegExp(pattern as string));
	}

	for (const [name, expectedJson] of Object.entries(expected.queryJson ?? {})) {
		const raw = request.url.searchParams.get(name);
		expect(raw, `query parameter ${name}`).not.toBeNull();
		// Structural, not textual: key order and percent-encoding both differ
		// legitimately between implementations.
		expect(JSON.parse(raw as string)).toEqual(expectedJson);
	}
	for (const name of expected.queryAbsent ?? []) {
		expect(request.url.searchParams.get(name), `query parameter ${name}`).toBeNull();
	}
	for (const [name, keys] of Object.entries(expected.queryJsonAbsentKeys ?? {})) {
		const actual = JSON.parse(request.url.searchParams.get(name) as string);
		for (const key of keys as string[]) {
			expect(Object.hasOwn(actual, key), `${name}.${key} must not be serialized`).toBe(false);
		}
	}

	if (expected.bodyText !== undefined) expect(request.bodyText).toBe(expected.bodyText);
}

const ERROR_STATUS: Record<string, number> = {
	BadRequest: 400,
	Unauthorized: 401,
	Forbidden: 403,
	NotFound: 404,
	PayloadTooLarge: 413,
	RateLimited: 429,
	ServerError: 500,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function assertError(expectedError: any, error: any, requestId?: string | null): void {
	// n8n models every API failure as NodeApiError, so the contract's error "kind"
	// is asserted through the status it maps to rather than a distinct class.
	if (expectedError.kind !== undefined && expectedError.status === undefined) {
		expect(Number(error.httpCode)).toBe(ERROR_STATUS[expectedError.kind]);
	}
	if (expectedError.status !== undefined) expect(Number(error.httpCode)).toBe(expectedError.status);
	if (expectedError.message !== undefined) expect(error.message).toBe(expectedError.message);
	if (expectedError.messageNonEmpty === true) expect(String(error.message).trim()).not.toBe('');
	if (expectedError.messageMaxLength !== undefined) {
		// The contract caps the *extracted* message; n8n's own "…" ellipsis marker
		// is one extra character on top of the 512 the rule allows.
		expect(String(error.message).length).toBeLessThanOrEqual(expectedError.messageMaxLength + 1);
	}
	if (expectedError.isPaidFeature === true) {
		expect(error.description ?? '').toMatch(/paid LabelZoom plan/i);
	}
	if (expectedError.retryAfterSeconds !== undefined) {
		// Surfaced in the error so a workflow author can see how long to wait; also
		// observable as the sleep the transport performed when retry is enabled.
		expect(error.description ?? '').toContain(`retry after ${expectedError.retryAfterSeconds} seconds`);
	}
	if ('requestId' in expectedError) {
		expect(requestId ?? null).toBe(expectedError.requestId);
	}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runResponseCase(given: any, expected: any): Promise<void> {
	// Retry is the subject of retry/*; leaving it on here would consume responses
	// that a single-response fixture does not script.
	const { ctx } = harnessFor(given, [given], 0);
	const call = convert.call(ctx, 0);

	if (expected.error !== undefined) {
		const error = await call.then(
			() => {
				throw new Error('Expected the call to reject.');
			},
			(e: unknown) => e,
		);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const requestId = (error as any).description?.match(/request ID: (\S+?) /)?.[1] ?? null;
		assertError(expected.error, error, expected.error.requestId === null ? null : requestId);
		return;
	}

	const result = await call;
	const r = expected.result;
	if (r.contentType !== undefined) expect(result.json.contentType).toBe(r.contentType);
	if (r.text !== undefined) {
		// `text` is surfaced only for genuinely textual targets, and is decoded with
		// the charset the response declared. The bytes stay authoritative.
		expect(result.json.text).toBe(r.text);
	}
	if (r.bytesBase64 !== undefined) {
		expect(result.binary?.data.data).toBe(r.bytesBase64);
	}
	if ('requestId' in r) {
		expect(result.json.requestId ?? null).toBe(r.requestId);
	}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runRetryCase(given: any, expected: any): Promise<void> {
	// Full jitter picks a delay in [0, base); pinning Math.random to 1 makes it
	// exactly `base`, which is the value the fixtures state.
	const random = vi.spyOn(Math, 'random').mockReturnValue(1);
	try {
		const { ctx, requests } = harnessFor(given, given.responses, given.maxRetries);
		const call = convert.call(ctx, 0);

		if (expected.error !== undefined) {
			const error = await call.then(
				() => {
					throw new Error('Expected the call to reject.');
				},
				(e: unknown) => e,
			);
			assertError(expected.error, error);
		} else {
			const result = await call;
			if (expected.result?.text !== undefined) {
				const bytes = Buffer.from(result.binary?.data.data as string, 'base64');
				expect(bytes.toString('utf8')).toBe(expected.result.text);
			}
		}

		expect(requests.length, 'attempts').toBe(expected.attempts);
		expect(sleeps.map((ms) => ms / 1000)).toEqual(expected.sleepsSeconds);
	} finally {
		random.mockRestore();
	}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runValidationCase(given: any, expected: any): Promise<void> {
	const { ctx, requests } = harnessFor(given, [OK_RESPONSE]);

	let thrown: unknown;
	try {
		await convert.call(ctx, 0);
	} catch (error) {
		thrown = error;
	}

	expect(thrown).toBeInstanceOf(LabelZoomValidationError);
	expect((thrown as LabelZoomValidationError).parameter).toBe(expected.validationError.parameter);
	// Local validation must never reach the network.
	expect(requests.length, 'requests sent').toBe(expected.requestsSent);
}

/**
 * The runtime stand-in for "this snippet must not compile".
 *
 * A test cannot assert a compile error about itself, so it asserts the property
 * that makes the compile error inevitable: TargetFormat contains no source-only
 * format, and the node's Target Format dropdown is built from that same list.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function runTypecheckCase(given: any): void {
	const snippet: string = given.snippet;

	for (const sourceOnly of ['url', 'jpg']) {
		if (snippet.toLowerCase().includes(`to(${sourceOnly})`)) {
			expect(TARGET_FORMATS as readonly string[]).not.toContain(sourceOnly);
		}
	}
	if (snippet.includes('SourceFormat.')) {
		expect(TARGET_FORMATS as readonly string[]).not.toContain('url');
	}
}

const executed = new Set<string>();

beforeEach(() => {
	sleeps.length = 0;
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('conformance', () => {
	for (const caseId of expectedCaseIds) {
		it(caseId, async () => {
			const { given, expect: expected } = fixture(caseId);

			switch (caseId.split('/')[0]) {
				case 'request':
					await runRequestCase(given, expected);
					break;
				case 'response':
					await runResponseCase(given, expected);
					break;
				case 'retry':
					await runRetryCase(given, expected);
					break;
				case 'validation':
					await runValidationCase(given, expected);
					break;
				case 'typecheck':
					runTypecheckCase(given);
					break;
				default:
					throw new Error(`Unknown case kind for '${caseId}'.`);
			}

			executed.add(caseId);
		});
	}

	/**
	 * The whole anti-drift mechanism. A suite that quietly runs a subset of the
	 * fixtures reports success exactly like one that runs all of them, so coverage
	 * is asserted rather than assumed.
	 */
	it('covers every declared case', () => {
		expect(spec.version, 'vendored spec version').toBe('1.1.0');
		expect(allCaseIds.length, 'case count').toBe(spec.caseCount);

		for (const [id, reason] of Object.entries(skips)) {
			expect(allCaseIds, `conformance-skips.json declares unknown case '${id}'`).toContain(id);
			expect(reason.trim(), `skip '${id}' has no reason`).not.toBe('');
		}

		expect([...executed].sort()).toEqual([...expectedCaseIds].sort());
	});
});
