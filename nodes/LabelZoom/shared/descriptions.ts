import type { INodeProperties } from 'n8n-workflow';

/**
 * Field groups shared by the Convert and Print operations. Both send the same
 * transformation parameters — a print job runs through the conversion pipeline on
 * its way to the printer, so `rotation`, `dpi` and friends apply there too, even
 * when no format change is needed.
 */

/** The document input: a binary file from a previous node, or inline text. */
export function documentInputFields(showFor: {
	resource: string[];
	operation: string[];
}): INodeProperties[] {
	return [
		{
			displayName: 'Input Type',
			name: 'inputType',
			type: 'options',
			noDataExpression: true,
			options: [
				{
					name: 'Binary File',
					value: 'binary',
					description: 'Use a file attached to the incoming item (a PDF, PNG, or label file)',
				},
				{
					name: 'Text',
					value: 'text',
					description: 'Type or map label code directly (ZPL, EPL, TSPL, DPL, XML, JSON)',
				},
				{
					name: 'Base64 Text',
					value: 'base64',
					description:
						'A base64-encoded PDF or image, sent as text. Useful when an upstream node hands you base64 rather than a file.',
				},
			],
			default: 'binary',
			displayOptions: { show: showFor },
		},
		{
			displayName: 'Input Binary Field',
			name: 'binaryPropertyName',
			type: 'string',
			default: 'data',
			required: true,
			hint: 'The name of the input field containing the file to process',
			displayOptions: { show: { ...showFor, inputType: ['binary'] } },
		},
		{
			displayName: 'Label Content',
			name: 'labelContent',
			type: 'string',
			typeOptions: { rows: 4 },
			default: '',
			required: true,
			placeholder: '^XA^FO50,50^ADN,36,20^FDLabelZoom^FS^XZ',
			description: 'The label code to send. For the URL source format, put the URL here instead.',
			displayOptions: { show: { ...showFor, inputType: ['text', 'base64'] } },
		},
	];
}

/** The `params` collection — every documented conversion parameter, plus an escape hatch. */
export function conversionOptionsField(
	showFor: { resource: string[]; operation: string[] },
	displayName = 'Options',
): INodeProperties {
	return {
		displayName,
		name: 'options',
		type: 'collection',
		placeholder: 'Add option',
		default: {},
		displayOptions: { show: showFor },
		options: [
			{
				displayName: 'Color Mode',
				name: 'colorMode',
				type: 'options',
				options: [
					{ name: 'Black and White', value: 'BW' },
					{ name: 'Color', value: 'COLOR' },
					{ name: 'Grayscale', value: 'GRAYSCALE' },
				],
				default: 'GRAYSCALE',
				description: 'How color is handled in image or ZPL output',
			},
			{
				displayName: 'Custom Parameters (JSON)',
				name: 'customParameters',
				type: 'json',
				default: '',
				description:
					'Any parameter not listed here, merged into the request. Unknown keys are ignored by the server, so this is safe to use for newly released options.',
			},
			{
				displayName: 'Darkness',
				name: 'darkness',
				type: 'number',
				typeOptions: { minValue: 0, maxValue: 100 },
				default: 70,
				description:
					'Luminance threshold (0-100) used when flattening color or grayscale to fewer colors. Raise it to darken thin lines and small text.',
			},
			{
				displayName: 'Dialect',
				name: 'dialect',
				type: 'string',
				default: '',
				placeholder: 'moca',
				description: 'Output dialect. Requires a paid plan.',
			},
			{
				displayName: 'DPI',
				name: 'dpi',
				type: 'number',
				default: 203,
				description:
					'Print density in dots per inch. Thermal printers are commonly 203; match the printer you will send to.',
			},
			{
				displayName: 'Label Height (Inches)',
				name: 'labelHeight',
				type: 'number',
				default: 6,
				description: 'Override the output label height. Leave unset to detect it from the source.',
			},
			{
				displayName: 'Label Width (Inches)',
				name: 'labelWidth',
				type: 'number',
				default: 4,
				description: 'Override the output label width. Leave unset to detect it from the source.',
			},
			{
				displayName: 'PDF Conversion Mode',
				name: 'pdfConversionMode',
				type: 'options',
				options: [
					{
						name: 'Image',
						value: 'IMAGE',
						description: 'Rasterize each page, preserving the exact appearance',
					},
					{
						name: 'Native',
						value: 'NATIVE',
						description: 'Extract the underlying vector and text content',
					},
				],
				default: 'IMAGE',
				description: 'How a PDF source is converted',
			},
			{
				displayName: 'PDF Page Number',
				name: 'pdfPageNumber',
				type: 'number',
				default: 0,
				description: 'Convert a single PDF page (0-based). Leave unset to convert every page.',
			},
			{
				displayName: 'Position X',
				name: 'positionX',
				type: 'number',
				default: 0,
				description: 'Horizontal offset in pixels of the top-left extraction corner',
			},
			{
				displayName: 'Position Y',
				name: 'positionY',
				type: 'number',
				default: 0,
				description: 'Vertical offset in pixels of the top-left extraction corner',
			},
			{
				displayName: 'Rotation',
				name: 'rotation',
				type: 'number',
				default: 0,
				description: 'Rotate the output in degrees. Must be a multiple of 90.',
			},
			{
				displayName: 'Scaling (%)',
				name: 'scaling',
				type: 'number',
				default: 100,
				description: 'Scale the output. 50 halves it, 200 doubles it.',
			},
			{
				displayName: 'Variable Data (JSON)',
				name: 'data',
				type: 'json',
				default: '',
				placeholder: '[{"sku": "A-100"}, {"sku": "A-101"}]',
				description:
					'Values used to fill variable fields on the label. Each array entry produces one label in the output.',
			},
			{
				displayName: 'Watermark',
				name: 'watermark',
				type: 'boolean',
				default: false,
				description: 'Whether to force a watermark on the output',
			},
			{
				displayName: 'ZPL Commands to Ignore',
				name: 'zplCommandsToIgnore',
				type: 'string',
				default: '',
				placeholder: '^PQ, ^MC',
				description: 'Comma-separated ZPL commands the parser should skip',
			},
			{
				displayName: 'ZPL Image Compression',
				name: 'zplImageCompression',
				type: 'options',
				options: [
					{ name: 'Z64', value: 'Z64', description: 'Compact zlib-compressed, base64-encoded' },
					{
						name: 'Compressed Hex',
						value: 'COMPRESSED_HEX',
						description: 'More widely compatible with older firmware',
					},
				],
				default: 'Z64',
				description: 'Image compression when writing ZPL output',
			},
		],
	};
}
