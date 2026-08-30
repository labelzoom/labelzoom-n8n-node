import type { ILoadOptionsFunctions, INodeListSearchResult, JsonObject } from 'n8n-workflow';

import { labelZoomJsonRequest } from '../shared/transport';

/**
 * Populate the printer dropdown from `GET /api/v3/printers`.
 *
 * Requires an API key with the `print` scope (or a signed-in session). A
 * `convert`-only key gets a 403 here, which surfaces as an empty list with the
 * server's own message — that is the right place to learn you picked the wrong
 * scope, rather than at print time.
 */
export async function getPrinters(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const response = await labelZoomJsonRequest.call(this, 'GET', '/api/v3/printers');
	const printers = Array.isArray(response.printers) ? (response.printers as JsonObject[]) : [];

	const results = printers
		.map((printer) => {
			const config = (printer.config ?? {}) as JsonObject;
			const nativeFormat =
				typeof config.nativeFormat === 'string' ? config.nativeFormat.toUpperCase() : 'unknown';
			const status = typeof printer.status === 'string' ? printer.status : 'unknown';
			return {
				// The native format is the single most useful thing to see while
				// picking: it is what the document will be converted to in transit.
				name: `${String(printer.name ?? printer.id)} — ${nativeFormat} (${status})`,
				value: String(printer.id),
			};
		})
		.filter((option) =>
			filter === undefined || filter === ''
				? true
				: option.name.toLowerCase().includes(filter.toLowerCase()),
		)
		.sort((a, b) => a.name.localeCompare(b.name));

	return { results };
}
