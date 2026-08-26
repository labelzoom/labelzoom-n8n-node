import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import {
	TARGET_FORMATS,
	formatOptions,
	isTextualTarget,
	targetExtension,
	targetMediaType,
} from '../../shared/formats';
import { contentTypeOf, decodeText, labelZoomRequest, requestIdOf } from '../../shared/transport';
import { resourceId } from '../../shared/utils';
import { templateLocator } from '../printer/shared';

const showFor = { resource: ['label'], operation: ['convertTemplate'] };

export const convertTemplateDescription: INodeProperties[] = [
	templateLocator(showFor),
	{
		displayName: 'Merge Data (JSON)',
		name: 'mergeData',
		type: 'json',
		default: '{}',
		required: true,
		description:
			'Values for the template\'s merge fields, keyed by field name. Use the Get Template operation, or the LabelZoom dashboard, to see which fields a template exposes.',
		displayOptions: { show: showFor },
	},
	{
		displayName: 'Target Format',
		name: 'targetFormat',
		type: 'options',
		options: [
			{ name: 'Template Default', value: '' },
			...formatOptions(TARGET_FORMATS),
		],
		default: '',
		description: "Override the template's own default output format",
		displayOptions: { show: showFor },
	},
	{
		displayName: 'Output Binary Field',
		name: 'outputBinaryPropertyName',
		type: 'string',
		default: 'data',
		required: true,
		hint: 'The name of the output field to put the rendered label in',
		displayOptions: { show: showFor },
	},
];

export async function convertTemplate(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData> {
	const templateId = resourceId.call(this, 'templateId', itemIndex);
	const targetFormat = this.getNodeParameter('targetFormat', itemIndex, '') as string;
	const outputBinaryPropertyName = this.getNodeParameter(
		'outputBinaryPropertyName',
		itemIndex,
	) as string;
	const rawMergeData = this.getNodeParameter('mergeData', itemIndex, '{}');

	let mergeData: unknown;
	if (typeof rawMergeData === 'string') {
		try {
			mergeData = JSON.parse(rawMergeData);
		} catch (error) {
			throw new NodeOperationError(
				this.getNode(),
				`Merge Data is not valid JSON: ${(error as Error).message}`,
				{ itemIndex },
			);
		}
	} else {
		mergeData = rawMergeData;
	}

	// One object per item. The endpoint also accepts an array, but then it returns
	// JSON describing N labels instead of raw bytes, which is a different output
	// shape for the same operation. n8n already models "many" as many items.
	if (Array.isArray(mergeData)) {
		throw new NodeOperationError(
			this.getNode(),
			'Merge Data must be a single JSON object, not an array',
			{
				itemIndex,
				description:
					'Send one item per label — n8n runs this operation once per input item, and each run produces one label.',
			},
		);
	}

	const response = await labelZoomRequest.call(this, {
		method: 'POST',
		path: `/api/v3/templates/${encodeURIComponent(templateId)}/convert`,
		query: targetFormat === '' ? undefined : { target: targetFormat },
		body: JSON.stringify(mergeData),
		contentType: 'application/json',
	});

	// The endpoint reports what it actually produced, which may be the template's
	// default rather than anything we asked for.
	const actualFormat =
		(Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'x-lz-format')?.[1] as
			| string
			| undefined) ??
		(targetFormat === '' ? 'zpl' : targetFormat);

	const mimeType = contentTypeOf(response)?.split(';')[0].trim() ?? targetMediaType(actualFormat);

	const json: IDataObject = {
		templateId,
		targetFormat: actualFormat,
		contentType: contentTypeOf(response),
		byteLength: response.body.length,
		requestId: requestIdOf(response),
	};
	if (isTextualTarget(actualFormat)) {
		json.text = decodeText(response);
	}

	return {
		json,
		binary: {
			[outputBinaryPropertyName]: await this.helpers.prepareBinaryData(
				response.body,
				`label.${targetExtension(actualFormat)}`,
				mimeType,
			),
		},
		pairedItem: { item: itemIndex },
	};
}
