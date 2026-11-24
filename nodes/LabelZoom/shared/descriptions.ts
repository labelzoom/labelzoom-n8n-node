import type { INodeProperties } from 'n8n-workflow';

/**
 * Field groups shared by the Convert and Print operations. Both send the same
 * transformation parameters — a print job runs through the conversion pipeline on
 * its way to the printer, so `rotation`, `dpi` and friends apply there too, even
 * when no format change is needed.
 */

/** The document input: a binary file from a previous node, or inline text. */
export function documentInputFields(
	showFor: {
		resource: string[];
		operation: string[];
	},
	{ allowBase64 = true }: { allowBase64?: boolean } = {},
): INodeProperties[] {
	const inputTypes = [
		{
			name: 'Binary File',
			value: 'binary',
			description: 'Use a file attached to the incoming item (a PDF, PNG, or label file)',
		},
		{
			name: 'Text',
			value: 'text',
			description:
				'Type or map label code directly (ZPL, EPL, IPL, TSPL, DPL, SBPL, CPCL, XML, JSON and the other text formats)',
		},
		{
			name: 'Base64 Text',
			value: 'base64',
			description:
				'A base64-encoded PDF or image, sent as text. Useful when an upstream node hands you base64 rather than a file.',
		},
	];
	return [
		{
			displayName: 'Input Type',
			name: 'inputType',
			type: 'options',
			noDataExpression: true,
			// Print reads the body as the format's own bytes, so base64 text would
			// reach the printer as base64 (contract rule P2). Turn base64 into a file
			// with n8n's Convert to File node first.
			options: allowBase64 ? inputTypes : inputTypes.filter((type) => type.value !== 'base64'),
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
				displayName: 'Collapse Identical Labels',
				name: 'zplCollapseCopies',
				type: 'boolean',
				default: false,
				description:
					'Whether to write each run of identical labels as one ZPL label with a ^PQ count. Image or PDF to ZPL, in Image mode.',
			},
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
				// Node version 1 only. Version 2 splits it into Source DPI and Target DPI,
				// and saved version 1 workflows keep sending exactly what they sent before.
				displayName: 'DPI',
				name: 'dpi',
				type: 'number',
				default: 203,
				description:
					'Print density in dots per inch. Thermal printers are commonly 203; match the printer you will send to.',
				displayOptions: { show: { '@version': [1] } },
			},
			{
				displayName: 'Label Height (Inches)',
				name: 'labelHeight',
				type: 'number',
				default: 6,
				description: 'Override the output label height. Leave unset to detect it from the source.',
			},
			{
				displayName: 'Label Index',
				name: 'labelIndex',
				type: 'number',
				typeOptions: { minValue: 0, numberPrecision: 0 },
				default: 0,
				description:
					'Convert only this label of a multi-label document (0-based, counted after any split). Leave unset to convert every label.',
			},
			{
				displayName: 'Label Width (Inches)',
				name: 'labelWidth',
				type: 'number',
				default: 4,
				description: 'Override the output label width. Leave unset to detect it from the source.',
			},
			{
				displayName: 'Layout',
				name: 'layout',
				type: 'collection',
				placeholder: 'Add layout field',
				default: {},
				description:
					'Print several labels side by side on one row of a multi-across roll. Image or PDF to ZPL, in Image mode.',
				options: [
					{
						displayName: 'Across',
						name: 'across',
						type: 'number',
						typeOptions: { minValue: 1, maxValue: 10, numberPrecision: 0 },
						default: 1,
						description: 'How many labels share one printed row, from 1 to 10',
					},
					{
						displayName: 'Fill',
						name: 'fill',
						type: 'options',
						options: [
							{
								name: 'Sequential',
								value: 'SEQUENTIAL',
								description: 'Each label once, in order, across then down',
							},
							{
								name: 'Repeat',
								value: 'REPEAT',
								description: 'Every slot in a row repeats the same label',
							},
						],
						default: 'SEQUENTIAL',
						description: 'How labels fill the slots in each row',
					},
					{
						displayName: 'Gap (Inches)',
						name: 'gap',
						type: 'number',
						typeOptions: { minValue: 0 },
						default: 0,
						description: 'Space between labels in a row',
					},
				],
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
				displayName: 'Source DPI',
				name: 'sourceDpi',
				type: 'number',
				default: 203,
				description:
					'The resolution the label code or image was made for, in dots per inch. Printer-language and image sources only. When Target DPI is unset, the output follows it.',
				displayOptions: { show: { '@version': [{ _cnd: { gte: 2 } }] } },
			},
			{
				displayName: 'Split Page Into Labels',
				name: 'split',
				type: 'collection',
				placeholder: 'Add split field',
				default: {},
				description:
					'Cut each page into a grid of labels, such as a sheet of 30 address labels. Image or PDF to ZPL, in Image mode. Lengths are in inches on the source page.',
				options: [
					{
						displayName: 'Column Gap (Inches)',
						name: 'columnGap',
						type: 'number',
						typeOptions: { minValue: 0 },
						default: 0,
					},
					{
						displayName: 'Columns',
						name: 'columns',
						type: 'number',
						typeOptions: { minValue: 1, maxValue: 20, numberPrecision: 0 },
						default: 1,
						description: 'Labels across the page, from 1 to 20',
					},
					{
						displayName: 'Label Height (Inches)',
						name: 'height',
						type: 'number',
						typeOptions: { minValue: 0 },
						default: 1,
						description: 'Leave unset to divide the page equally',
					},
					{
						displayName: 'Label Width (Inches)',
						name: 'width',
						type: 'number',
						typeOptions: { minValue: 0 },
						default: 1,
						description: 'Leave unset to divide the page equally',
					},
					{
						displayName: 'Left Margin (Inches)',
						name: 'left',
						type: 'number',
						typeOptions: { minValue: 0 },
						default: 0,
						description: 'From the left edge of the page to the first column',
					},
					{
						displayName: 'Row Gap (Inches)',
						name: 'rowGap',
						type: 'number',
						typeOptions: { minValue: 0 },
						default: 0,
					},
					{
						displayName: 'Rows',
						name: 'rows',
						type: 'number',
						typeOptions: { minValue: 1, maxValue: 20, numberPrecision: 0 },
						default: 1,
						description: 'Labels down the page, from 1 to 20. A page holds at most 100 labels.',
					},
					{
						displayName: 'Skip Blank Labels',
						name: 'skipBlank',
						type: 'boolean',
						default: false,
						description: 'Whether to leave out labels with nothing printable on them',
					},
					{
						displayName: 'Top Margin (Inches)',
						name: 'top',
						type: 'number',
						typeOptions: { minValue: 0 },
						default: 0,
						description: 'From the top edge of the page to the first row',
					},
				],
			},
			{
				displayName: 'Target DPI',
				name: 'targetDpi',
				type: 'number',
				default: 203,
				description:
					'The resolution of the output, in dots per inch. Match the printer you will send to. Every target but PDF.',
				displayOptions: { show: { '@version': [{ _cnd: { gte: 2 } }] } },
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
