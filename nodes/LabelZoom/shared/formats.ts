/**
 * The LabelZoom format tables, mirroring `labelzoom-sdk`'s `node/src/formats.ts`
 * and §1.1/§1.2 of the API contract.
 *
 * `jpg` and `url` are source-only: `jpg` is an input spelling that normalizes to
 * `jpeg` before the path is built (contract rule A2), and `url` tells the server
 * to go fetch a document rather than naming an output.
 */

export const SOURCE_FORMATS = [
	'zpl',
	'epl',
	'tspl',
	'dpl',
	'xml',
	'json',
	'pdf',
	'png',
	'bmp',
	'gif',
	'jpeg',
	'jpg',
	'url',
] as const;

export const TARGET_FORMATS = [
	'zpl',
	'epl',
	'tspl',
	'dpl',
	'xml',
	'json',
	'pdf',
	'png',
	'bmp',
	'gif',
	'jpeg',
] as const;

export type SourceFormat = (typeof SOURCE_FORMATS)[number];
export type TargetFormat = (typeof TARGET_FORMATS)[number];

/** Request `Content-Type` per source format (contract §1.2). */
const SOURCE_MEDIA_TYPES: Record<SourceFormat, string> = {
	zpl: 'text/plain',
	epl: 'text/plain',
	tspl: 'text/plain',
	dpl: 'text/plain',
	xml: 'application/xml',
	json: 'application/json',
	pdf: 'application/pdf',
	png: 'image/png',
	bmp: 'image/bmp',
	gif: 'image/gif',
	jpeg: 'image/jpeg',
	jpg: 'image/jpeg',
	url: 'text/plain',
};

/** Response media type per target format, used to label the output binary. */
const TARGET_MEDIA_TYPES: Record<TargetFormat, string> = {
	zpl: 'text/plain',
	epl: 'text/plain',
	tspl: 'text/plain',
	dpl: 'text/plain',
	xml: 'application/xml',
	json: 'application/json',
	pdf: 'application/pdf',
	png: 'image/png',
	bmp: 'image/bmp',
	gif: 'image/gif',
	jpeg: 'image/jpeg',
};

const TARGET_EXTENSIONS: Record<TargetFormat, string> = {
	zpl: 'zpl',
	epl: 'epl',
	tspl: 'txt',
	dpl: 'dpl',
	xml: 'xml',
	json: 'json',
	pdf: 'pdf',
	png: 'png',
	bmp: 'bmp',
	gif: 'gif',
	jpeg: 'jpg',
};

/**
 * Targets whose bytes are safe to expose as a decoded string.
 *
 * `epl`, `tspl` and `dpl` are deliberately absent even though they come back as
 * `text/plain`: EPL's `GW` and TSPL's `BITMAP` commands inline a raw 1-bpp image
 * payload, and DPL output opens with a literal STX (0x02). Decoding those to a
 * string corrupts every label that carries graphics, so the node only ever hands
 * them onward as binary.
 */
const TEXTUAL_TARGETS = new Set<TargetFormat>(['zpl', 'xml', 'json']);

export function sourceMediaType(format: string): string {
	return SOURCE_MEDIA_TYPES[format as SourceFormat] ?? 'application/octet-stream';
}

export function targetMediaType(format: string): string {
	return TARGET_MEDIA_TYPES[format as TargetFormat] ?? 'application/octet-stream';
}

export function targetExtension(format: string): string {
	return TARGET_EXTENSIONS[format as TargetFormat] ?? 'bin';
}

export function isTextualTarget(format: string): boolean {
	return TEXTUAL_TARGETS.has(format as TargetFormat);
}

/** Contract rule A2: `jpg` normalizes to `jpeg` before the path is constructed. */
export function sourceWireToken(format: string): string {
	const lower = format.toLowerCase();
	return lower === 'jpg' ? 'jpeg' : lower;
}

const FORMAT_LABELS: Record<string, string> = {
	zpl: 'ZPL (Zebra)',
	epl: 'EPL (Eltron)',
	tspl: 'TSPL (TSC)',
	dpl: 'DPL (Datamax)',
	xml: 'XML (LBXML)',
	json: 'JSON (LabelZoom)',
	pdf: 'PDF',
	png: 'PNG',
	bmp: 'BMP',
	gif: 'GIF',
	jpeg: 'JPEG',
	jpg: 'JPG (Alias for JPEG)',
	url: 'URL (Fetched by the Server)',
};

export function formatOptions(formats: readonly string[]) {
	return formats.map((value) => ({ name: FORMAT_LABELS[value] ?? value.toUpperCase(), value }));
}
