import type { IDataObject, INode } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { LabelZoomValidationError } from './validation';

/**
 * Turn the node's flat "Options" collection into the nested JSON the API expects,
 * mirroring `labelzoom-sdk/node/src/options.ts`.
 *
 * Rule C1: only options the user explicitly set are serialized. A client-side
 * default must never be sent — the server's own defaults are the source of truth,
 * and echoing `dpi: 203` back at it would pin a value the user never chose.
 *
 * Rule C7: when nothing is set this returns `undefined`, and the caller omits the
 * query string entirely rather than sending `?params=%7B%7D`.
 */

export interface ConversionOptions extends IDataObject {
	dpi?: number;
	rotation?: number;
	scaling?: number;
	colorMode?: string;
	darkness?: number;
	positionX?: number;
	positionY?: number;
	watermark?: boolean;
	dialect?: string;
	labelWidth?: number;
	labelHeight?: number;
	pdfConversionMode?: string;
	pdfPageNumber?: number;
	zplImageCompression?: string;
	zplCommandsToIgnore?: string;
	data?: string;
	customParameters?: string;
}

function setNested(target: IDataObject, path: string[], value: unknown): void {
	let cursor = target;
	for (const segment of path.slice(0, -1)) {
		if (typeof cursor[segment] !== 'object' || cursor[segment] === null) cursor[segment] = {};
		cursor = cursor[segment] as IDataObject;
	}
	cursor[path[path.length - 1]] = value as IDataObject[string];
}

function parseJsonParameter(node: INode, label: string, raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch (error) {
		throw new NodeOperationError(node, `${label} is not valid JSON: ${(error as Error).message}`, {
			description: `Received: ${raw.slice(0, 200)}`,
		});
	}
}

/** Build the `params` object. Returns `undefined` when the user set nothing. */
export function buildConversionParams(node: INode, options: ConversionOptions): IDataObject | undefined {
	const params: IDataObject = {};

	if (options.dpi !== undefined) params.dpi = options.dpi;

	if (options.rotation !== undefined) {
		// Validated locally so an obviously-wrong value costs no API call — the
		// server rejects anything that isn't a multiple of 90 with a 400 anyway.
		if (options.rotation % 90 !== 0) {
			throw new LabelZoomValidationError(
				node,
				'rotation',
				`Rotation must be a multiple of 90, got ${options.rotation}`,
			);
		}
		params.rotation = options.rotation;
	}

	if (options.scaling !== undefined) params.scaling = options.scaling;
	if (options.colorMode !== undefined) params.colorMode = options.colorMode;

	if (options.darkness !== undefined) {
		if (options.darkness < 0 || options.darkness > 100) {
			throw new LabelZoomValidationError(
				node,
				'darkness',
				`Darkness must be between 0 and 100, got ${options.darkness}`,
			);
		}
		params.darkness = options.darkness;
	}

	if (options.positionX !== undefined) setNested(params, ['position', 'x'], options.positionX);
	if (options.positionY !== undefined) setNested(params, ['position', 'y'], options.positionY);
	if (options.watermark !== undefined) params.watermark = options.watermark;
	if (options.dialect !== undefined && options.dialect !== '') params.dialect = options.dialect;

	// Rule C4: label dimensions are in INCHES. Omitting the whole `label` key is
	// what makes the server detect the size from the source, so a partially-set
	// label object is meaningful and must not be filled in with a default.
	if (options.labelWidth !== undefined) setNested(params, ['label', 'width'], options.labelWidth);
	if (options.labelHeight !== undefined) setNested(params, ['label', 'height'], options.labelHeight);

	if (options.pdfConversionMode !== undefined) {
		setNested(params, ['pdf', 'conversionMode'], options.pdfConversionMode);
	}
	// 0-based, and 0 is a legitimate value — hence the explicit undefined check.
	if (options.pdfPageNumber !== undefined) {
		setNested(params, ['pdf', 'pageNumber'], options.pdfPageNumber);
	}

	if (options.zplImageCompression !== undefined) {
		setNested(params, ['zpl', 'imageCompression'], options.zplImageCompression);
	}
	if (options.zplCommandsToIgnore !== undefined && options.zplCommandsToIgnore !== '') {
		const commands = options.zplCommandsToIgnore
			.split(',')
			.map((command) => command.trim())
			.filter((command) => command !== '');
		if (commands.length > 0) setNested(params, ['zpl', 'commandsToIgnore'], commands);
	}

	if (options.data !== undefined && options.data !== '') {
		const parsed = parseJsonParameter(node, 'Variable Data', options.data);
		// Rule C3: a single object is wrapped into a one-element array. Each entry
		// produces one label in the output.
		const records = Array.isArray(parsed) ? parsed : [parsed];
		for (const record of records) {
			// A bare string or number here silently fills nothing — the server has no
			// field name to match it to — so the label prints blank rather than
			// failing. Catch it locally, where the cause is still obvious.
			if (typeof record !== 'object' || record === null || Array.isArray(record)) {
				throw new LabelZoomValidationError(
					node,
					'data',
					`Every entry in Variable Data must be a JSON object, got ${JSON.stringify(record)}`,
				);
			}
		}
		params.data = records;
	}

	if (options.customParameters !== undefined && options.customParameters !== '') {
		const parsed = parseJsonParameter(node, 'Custom Parameters', options.customParameters);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			throw new NodeOperationError(node, 'Custom Parameters must be a JSON object');
		}
		// Merged last so an escape-hatch value wins over a UI field of the same
		// name — unknown keys are ignored server-side, so this is safe.
		Object.assign(params, parsed);
	}

	return Object.keys(params).length === 0 ? undefined : params;
}

/** Serialize to the exact string that goes into `?params=`, or undefined. */
export function serializeConversionParams(node: INode, options: ConversionOptions): string | undefined {
	const params = buildConversionParams(node, options);
	return params === undefined ? undefined : JSON.stringify(params);
}
