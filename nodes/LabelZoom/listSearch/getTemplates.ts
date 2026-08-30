import type { ILoadOptionsFunctions, INodeListSearchResult, JsonObject } from 'n8n-workflow';

import { labelZoomJsonRequest } from '../shared/transport';

/**
 * Populate the Print Template dropdown from `GET /api/v3/templates`.
 *
 * Needs only the `convert` scope, which every API key has — `print` implies
 * `convert`, and `convert` is the default for a new key.
 */
export async function getTemplates(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const response = await labelZoomJsonRequest.call(this, 'GET', '/api/v3/templates');
	const templates = Array.isArray(response.templates) ? (response.templates as JsonObject[]) : [];

	const results = templates
		.map((template) => {
			const mergeFields = Array.isArray(template.merge_fields)
				? (template.merge_fields as string[])
				: [];
			// Showing the merge fields in the picker saves a round trip to the
			// dashboard to find out what data the template actually wants.
			const fields = mergeFields.length > 0 ? ` — ${mergeFields.join(', ')}` : '';
			return {
				name: `${String(template.name ?? template.id)}${fields}`,
				value: String(template.id),
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
