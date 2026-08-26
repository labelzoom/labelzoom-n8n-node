import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INode,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError, sleep } from 'n8n-workflow';

/**
 * Every rule in this file comes from `labelzoom-sdk/docs/API_CONTRACT.md`, which
 * is the normative wire contract all LabelZoom clients share. The rule ids in the
 * comments (A3, B2, C2, …) refer to it. Please don't "simplify" any of them away
 * — each one exists because the obvious alternative fails in production.
 */

export const DEFAULT_BASE_URL = 'https://api.labelzoom.com';
export const CREDENTIAL_NAME = 'labelZoomApi';

/** Rule F2: 3 attempts total by default — the initial call plus two retries. */
const DEFAULT_MAX_RETRIES = 2;

type RequestContext = IExecuteFunctions | ILoadOptionsFunctions;

export interface LabelZoomResponse {
	statusCode: number;
	headers: Record<string, unknown>;
	/** Raw response bytes. Authoritative for every target — see decodeIfTextual(). */
	body: Buffer;
}

export interface LabelZoomRequest {
	method: IHttpRequestMethods;
	/** Path only, e.g. `/api/v2/convert/zpl/to/pdf`. */
	path: string;
	/** Serialized straight into `?params=<encoded JSON>`; omitted when undefined. */
	params?: string;
	/** Extra query parameters that are NOT part of the params JSON (e.g. sourceFormat). */
	query?: Record<string, string>;
	body?: Buffer | string;
	contentType?: string;
	headers?: Record<string, string>;
}

/**
 * Resolve the configured credential, or `undefined` when the node is running
 * anonymously.
 *
 * Rule G1: constructing a client without a credential must work — anonymous
 * callers get the free tier (watermarked, first label only, 1 MB body cap). The
 * Label resource declares its credential as optional for exactly this reason, and
 * `getCredentials` throws rather than returning undefined when none is set.
 */
export async function getCredentialsIfAny(
	ctx: RequestContext,
): Promise<{ apiKey?: string; baseUrl?: string; maxRetries?: number } | undefined> {
	try {
		return (await ctx.getCredentials(CREDENTIAL_NAME)) as {
			apiKey?: string;
			baseUrl?: string;
			maxRetries?: number;
		};
	} catch {
		return undefined;
	}
}

/** Rule A3: trailing slashes are normalized away; a path prefix is preserved. */
export function normalizeBaseUrl(baseUrl?: string): string {
	const trimmed = (baseUrl ?? '').trim();
	if (trimmed === '') return DEFAULT_BASE_URL;
	return trimmed.replace(/\/+$/, '');
}

function buildUrl(baseUrl: string, request: LabelZoomRequest): string {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(request.query ?? {})) {
		parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
	}
	// Rule C2: all conversion options travel in exactly one `params` query
	// parameter holding URL-encoded JSON. Never dot-notation — the server merges
	// both forms, but `?data=[{...}]` is a 400 because a query value cannot carry
	// an array. Rule C7: when nothing is set there is no query string at all.
	if (request.params !== undefined) {
		parts.push(`params=${encodeURIComponent(request.params)}`);
	}
	const query = parts.length > 0 ? `?${parts.join('&')}` : '';
	return `${baseUrl}${request.path}${query}`;
}

/** Rule F1: retry 429, 5xx and transport failures. Nothing else, ever. */
function isRetryableStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

function retryDelayMs(attempt: number, retryAfterHeader: unknown): number {
	// Rule F2: exponential backoff with full jitter, 1s / 2s / 4s.
	const base = 2 ** attempt * 1000;
	const jittered = Math.random() * base;
	const retryAfterSeconds = Number(retryAfterHeader);
	// Honour Retry-After when it asks for longer than our own backoff. The gateway
	// sends `Retry-After: 60` on a rate limit; ignoring it just burns the budget.
	if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds * 1000 > jittered) {
		return retryAfterSeconds * 1000;
	}
	return jittered;
}

function headerValue(headers: Record<string, unknown>, name: string): string | undefined {
	// Rule D2: header lookup is case-insensitive. The gateway sets
	// `X-LZ-Request-Id`; CORS exposes it spelled `X-LZ-Request-ID`.
	const lower = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lower) {
			return Array.isArray(value) ? String(value[0]) : String(value);
		}
	}
	return undefined;
}

export function requestIdOf(response: LabelZoomResponse): string | undefined {
	return headerValue(response.headers, 'x-lz-request-id');
}

export function contentTypeOf(response: LabelZoomResponse): string | undefined {
	return headerValue(response.headers, 'content-type');
}

export function retryAfterSecondsOf(response: LabelZoomResponse): number | undefined {
	const seconds = Number(headerValue(response.headers, 'retry-after'));
	return Number.isFinite(seconds) ? seconds : undefined;
}

/**
 * Rule D1: decode text using the charset the response declares, not a hardcoded
 * UTF-8.
 *
 * The engine emits ISO-8859-1 for some label sources, and a single accented
 * character in a latin-1 body decoded as UTF-8 becomes U+FFFD — a silently
 * corrupted label rather than an error. The bytes remain authoritative either
 * way; this only affects the convenience `text` field.
 */
export function decodeText(response: LabelZoomResponse): string {
	const charset = /charset=([^;\s]+)/i.exec(contentTypeOf(response) ?? '')?.[1];
	if (charset === undefined || /^utf-?8$/i.test(charset)) return response.body.toString('utf8');
	try {
		return new TextDecoder(charset.replace(/^"|"$/g, '')).decode(response.body);
	} catch {
		// An unknown label is not worth failing a conversion over.
		return response.body.toString('utf8');
	}
}

/**
 * Rule E2: message extraction order is JSON `.message`, then the raw body
 * truncated to 512 characters, then the HTTP reason phrase.
 *
 * Three different error bodies exist in this system and all three land here: the
 * gateway's `{ message }`, the gateway rate limiter's `{ error }` (deliberately
 * NOT special-cased — it falls through to the raw body), and Spring's
 * `{ timestamp, status, error, message, path }`.
 */
function extractMessage(response: LabelZoomResponse): string {
	const text = decodeText(response).trim();
	if (text !== '') {
		try {
			const parsed = JSON.parse(text) as JsonObject;
			if (typeof parsed?.message === 'string' && parsed.message !== '') return parsed.message;
		} catch {
			/* not JSON — fall through to the raw body */
		}
		return text.length > 512 ? `${text.slice(0, 512)}…` : text;
	}
	return `LabelZoom request failed with status ${response.statusCode}`;
}

function parsedBody(response: LabelZoomResponse): JsonObject | undefined {
	try {
		return JSON.parse(decodeText(response)) as JsonObject;
	} catch {
		return undefined;
	}
}

/** Turn a non-2xx LabelZoom response into the richest NodeApiError we can. */
export function toNodeApiError(node: INode, response: LabelZoomResponse): NodeApiError {
	const message = extractMessage(response);
	const body = parsedBody(response);
	const requestId = requestIdOf(response);

	const hints: string[] = [];
	// Rule E5: a 403 mentioning a paid feature is the single most common
	// anonymous-tier failure ("JSON export is a paid feature"). Say so plainly
	// rather than leaving the user to read a bare 403.
	if (response.statusCode === 403 && /paid feature/i.test(message)) {
		hints.push('This conversion path requires a paid LabelZoom plan.');
	}
	if (response.statusCode === 403 && /scope/i.test(message)) {
		hints.push('Create a new API key with the required scope in your LabelZoom dashboard.');
	}
	if (response.statusCode === 413) {
		hints.push('Bodies over 1 MB require a Pro plan or above.');
	}
	if (response.statusCode === 401) {
		hints.push('Check the API key on the LabelZoom credential.');
	}
	// The 422 from a template print carries which fields were missing, per row.
	if (Array.isArray(body?.problems)) {
		hints.push(`Missing merge fields: ${JSON.stringify(body.problems)}`);
	}
	const retryAfterSeconds = retryAfterSecondsOf(response);
	if (response.statusCode === 429 && retryAfterSeconds !== undefined) {
		hints.push(`Rate limited — retry after ${retryAfterSeconds} seconds.`);
	}
	if (requestId !== undefined) {
		hints.push(`LabelZoom request ID: ${requestId} (quote this to support).`);
	}

	// The status goes last so it always wins: NodeApiError infers httpCode from
	// this object, and a body without a `status` field (an empty 406, an HTML 502)
	// would otherwise leave the error with no status code at all.
	return new NodeApiError(
		node,
		{ ...(body ?? {}), message, status: response.statusCode } as JsonObject,
		{
			message,
			httpCode: String(response.statusCode),
			description: hints.length > 0 ? hints.join(' ') : undefined,
		},
	);
}

/**
 * Issue one LabelZoom request, with the contract's headers, retry policy and
 * error shape. Always returns raw bytes — callers decide whether decoding them to
 * a string is safe (it usually isn't).
 */
export async function labelZoomRequest(
	this: RequestContext,
	request: LabelZoomRequest,
): Promise<LabelZoomResponse> {
	const credentials = await getCredentialsIfAny(this);
	const baseUrl = normalizeBaseUrl(credentials?.baseUrl);
	const url = buildUrl(baseUrl, request);
	const hasApiKey = typeof credentials?.apiKey === 'string' && credentials.apiKey.trim() !== '';

	const headers: Record<string, string> = {
		// Rule B2: ALWAYS `*/*`, never the target's media type and never a q-value.
		// The backend's Spring `produces` list omits image/gif, image/bmp and
		// image/jpeg, so an exact Accept header 406s before the handler runs.
		Accept: '*/*',
		// Rule B4: must not begin `LabelZoomStudio/` — the server parses that
		// prefix and silently forces pdf.conversionMode = NATIVE.
		'User-Agent': 'labelzoom-n8n-node (n8n)',
		...(request.contentType !== undefined ? { 'Content-Type': request.contentType } : {}),
		...(request.headers ?? {}),
	};

	const options: IHttpRequestOptions = {
		method: request.method,
		url,
		headers,
		body: request.body,
		// Raw bytes in, raw bytes out. Five of the eleven targets are binary, and
		// two of the textual ones can inline binary payloads.
		encoding: 'arraybuffer',
		returnFullResponse: true,
		// We classify statuses ourselves so retry and error extraction can see the
		// body and the Retry-After header.
		ignoreHttpStatusErrors: true,
		json: false,
	};

	// Rule F3: a budget of 0 disables retry entirely.
	const maxRetries =
		typeof credentials?.maxRetries === 'number' && credentials.maxRetries >= 0
			? credentials.maxRetries
			: DEFAULT_MAX_RETRIES;

	let lastResponse: LabelZoomResponse | undefined;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		let raw: { statusCode: number; headers: Record<string, unknown>; body: unknown };
		try {
			raw = (hasApiKey
				? await this.helpers.httpRequestWithAuthentication.call(this, CREDENTIAL_NAME, options)
				: await this.helpers.httpRequest(options)) as typeof raw;
		} catch (error) {
			// Transport failure (DNS, connection reset, timeout) — retryable.
			if (attempt < maxRetries) {
				await sleep(retryDelayMs(attempt, undefined));
				continue;
			}
			throw new NodeApiError(this.getNode(), error as JsonObject, {
				message: 'Could not reach the LabelZoom API',
			});
		}

		lastResponse = {
			statusCode: raw.statusCode,
			headers: raw.headers ?? {},
			body: Buffer.isBuffer(raw.body)
				? raw.body
				: Buffer.from(raw.body as ArrayBuffer | string as never),
		};

		if (lastResponse.statusCode < 400) return lastResponse;

		// Never retry an auth failure. The gateway's intrusion protection locks an
		// IP out after 5 failed auths in 60 seconds, so hammering a bad credential
		// takes down every other workflow on this n8n instance too.
		if (!isRetryableStatus(lastResponse.statusCode) || attempt === maxRetries) {
			throw toNodeApiError(this.getNode(), lastResponse);
		}

		await sleep(retryDelayMs(attempt, headerValue(lastResponse.headers, 'retry-after')));
	}

	/* istanbul ignore next — the loop always returns or throws. */
	throw toNodeApiError(this.getNode(), lastResponse!);
}

/** Convenience wrapper for the JSON management endpoints (printers, templates, jobs). */
export async function labelZoomJsonRequest(
	this: RequestContext,
	method: IHttpRequestMethods,
	path: string,
	body?: IDataObject | IDataObject[],
	query?: Record<string, string>,
	headers?: Record<string, string>,
): Promise<JsonObject> {
	const response = await labelZoomRequest.call(this, {
		method,
		path,
		query,
		headers,
		...(body === undefined
			? {}
			: { body: JSON.stringify(body), contentType: 'application/json' }),
	});
	const text = response.body.toString('utf8');
	if (text.trim() === '') return {};
	try {
		return JSON.parse(text) as JsonObject;
	} catch {
		throw new NodeOperationError(
			this.getNode(),
			`Expected JSON from ${path} but got: ${text.slice(0, 200)}`,
		);
	}
}
