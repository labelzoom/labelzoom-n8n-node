import type { IExecuteFunctions, ILoadOptionsFunctions, INode } from 'n8n-workflow';

/**
 * A minimal stand-in for n8n's execution context.
 *
 * It emulates only what this node actually touches, and it emulates it the way
 * n8n does — most importantly `httpRequestWithAuthentication`, which applies the
 * credential's `authenticate` block. That is what makes an assertion about the
 * Authorization header meaningful here rather than circular.
 */

export interface RecordedRequest {
	method: string;
	url: URL;
	/** Lower-cased header names, matching how the conformance fixtures spell them. */
	headers: Record<string, string>;
	bodyText: string;
}

export interface ScriptedResponse {
	status: number;
	headers?: Record<string, string>;
	bodyText?: string;
	bodyBase64?: string;
	bodyTextRepeat?: [string, number];
	transportError?: string;
}

export interface HarnessOptions {
	parameters?: Record<string, unknown>;
	/** Omit entirely to run anonymously (no credential configured on the node). */
	credentials?: { apiKey?: string; baseUrl?: string; maxRetries?: number };
	binary?: Record<string, { data: Buffer; mimeType?: string; fileName?: string }>;
	responses?: ScriptedResponse[];
	items?: number;
	continueOnFail?: boolean;
}

export interface Harness {
	ctx: IExecuteFunctions & ILoadOptionsFunctions;
	requests: RecordedRequest[];
	sleeps: number[];
}

const NODE: INode = {
	id: 'test-node',
	name: 'LabelZoom',
	type: 'n8n-nodes-labelzoom.labelZoom',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

function bodyToText(body: unknown): string {
	if (body === undefined || body === null) return '';
	if (Buffer.isBuffer(body)) return body.toString('utf8');
	if (typeof body === 'string') return body;
	if (body instanceof ArrayBuffer) return Buffer.from(body).toString('utf8');
	return String(body);
}

function responseBody(scripted: ScriptedResponse): Buffer {
	if (scripted.bodyBase64 !== undefined) return Buffer.from(scripted.bodyBase64, 'base64');
	if (scripted.bodyTextRepeat !== undefined) {
		return Buffer.from(scripted.bodyTextRepeat[0].repeat(scripted.bodyTextRepeat[1]), 'utf8');
	}
	return Buffer.from(scripted.bodyText ?? '', 'utf8');
}

export function makeHarness(options: HarnessOptions = {}): Harness {
	const requests: RecordedRequest[] = [];
	const sleeps: number[] = [];
	const script = options.responses ?? [];
	let responseIndex = 0;

	const record = (requestOptions: Record<string, unknown>, extraHeaders: Record<string, string>) => {
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries({
			...((requestOptions.headers ?? {}) as Record<string, string>),
			...extraHeaders,
		})) {
			headers[key.toLowerCase()] = String(value);
		}
		requests.push({
			method: String(requestOptions.method ?? 'GET'),
			url: new URL(String(requestOptions.url)),
			headers,
			bodyText: bodyToText(requestOptions.body),
		});

		const scripted = script[responseIndex++];
		if (scripted === undefined) {
			throw new Error(
				`Unexpected request to ${String(requestOptions.url)}; no more responses are scripted.`,
			);
		}
		if (scripted.transportError !== undefined) {
			throw new TypeError(`fetch failed: ${scripted.transportError}`);
		}
		return {
			statusCode: scripted.status,
			headers: scripted.headers ?? {},
			body: responseBody(scripted),
		};
	};

	const httpRequest = async (requestOptions: Record<string, unknown>) => record(requestOptions, {});

	// n8n applies the credential's `authenticate` block here. LabelZoomApi declares
	// `Authorization: Bearer {{$credentials.apiKey}}`, so that is what we add.
	const httpRequestWithAuthentication = async (
		_credentialType: string,
		requestOptions: Record<string, unknown>,
	) => {
		const apiKey = options.credentials?.apiKey ?? '';
		return record(requestOptions, apiKey === '' ? {} : { Authorization: `Bearer ${apiKey}` });
	};

	const ctx = {
		getNode: () => NODE,
		continueOnFail: () => options.continueOnFail ?? false,
		getInputData: () => Array.from({ length: options.items ?? 1 }, () => ({ json: {} })),
		getCredentials: async (name: string) => {
			if (options.credentials === undefined) {
				throw new Error(`Node does not have any credentials of type "${name}" set`);
			}
			return options.credentials;
		},
		getNodeParameter: (
			name: string,
			_itemIndex: number,
			fallback?: unknown,
			extra?: { extractValue?: boolean },
		) => {
			const value = options.parameters?.[name];
			if (value === undefined) {
				if (fallback !== undefined) return fallback;
				throw new Error(`Test harness has no parameter "${name}"`);
			}
			// resourceLocator values collapse to their id when extractValue is set.
			if (extra?.extractValue === true && typeof value === 'object' && value !== null) {
				return (value as { value: unknown }).value;
			}
			return value;
		},
		logger: {
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: () => {},
		},
		helpers: {
			httpRequest,
			httpRequestWithAuthentication,
			assertBinaryData: (_itemIndex: number, propertyName: string) => {
				const entry = options.binary?.[propertyName];
				if (entry === undefined) {
					throw new Error(`No binary data named "${propertyName}"`);
				}
				return entry;
			},
			getBinaryDataBuffer: async (_itemIndex: number, propertyName: string) => {
				const entry = options.binary?.[propertyName];
				if (entry === undefined) throw new Error(`No binary data named "${propertyName}"`);
				return entry.data;
			},
			prepareBinaryData: async (buffer: Buffer, fileName?: string, mimeType?: string) => ({
				data: buffer.toString('base64'),
				fileName,
				mimeType,
				fileSize: buffer.length,
			}),
		},
	} as unknown as IExecuteFunctions & ILoadOptionsFunctions;

	return { ctx, requests, sleeps };
}
