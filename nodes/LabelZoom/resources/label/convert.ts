import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';

import { conversionOptionsField, documentInputFields } from '../../shared/descriptions';
import {
	SOURCE_FORMATS,
	TARGET_FORMATS,
	formatOptions,
	isTextualTarget,
	sourceMediaType,
	sourceWireToken,
	targetExtension,
	targetMediaType,
} from '../../shared/formats';
import type { ConversionOptions } from '../../shared/options';
import { serializeConversionParams } from '../../shared/options';
import { contentTypeOf, decodeText, labelZoomRequest, requestIdOf } from '../../shared/transport';
import { readDocument } from '../../shared/utils';

const showFor = { resource: ['label'], operation: ['convert'] };

export const convertDescription: INodeProperties[] = [
	{
		displayName: 'Source Format',
		name: 'sourceFormat',
		type: 'options',
		noDataExpression: true,
		options: formatOptions(SOURCE_FORMATS),
		default: 'zpl',
		description:
			'The format of the document you are sending. Choose URL to have LabelZoom fetch a document from a link instead of uploading it.',
		displayOptions: { show: showFor },
	},
	{
		displayName: 'Target Format',
		name: 'targetFormat',
		type: 'options',
		noDataExpression: true,
		options: formatOptions(TARGET_FORMATS),
		default: 'pdf',
		description: 'The format to convert to',
		displayOptions: { show: showFor },
	},
	...documentInputFields(showFor),
	{
		displayName: 'Output Binary Field',
		name: 'outputBinaryPropertyName',
		type: 'string',
		default: 'data',
		required: true,
		hint: 'The name of the output field to put the converted label in',
		displayOptions: { show: showFor },
	},
	conversionOptionsField(showFor),
];

export async function convert(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData> {
	const sourceFormat = this.getNodeParameter('sourceFormat', itemIndex) as string;
	const targetFormat = this.getNodeParameter('targetFormat', itemIndex) as string;
	const outputBinaryPropertyName = this.getNodeParameter(
		'outputBinaryPropertyName',
		itemIndex,
	) as string;
	const options = this.getNodeParameter('options', itemIndex, {}) as ConversionOptions;

	const document = await readDocument.call(this, itemIndex);

	// Rule B1: in base64/text mode the body travels as text/plain whatever the
	// source format is — that is the point of the mode, since a client using it
	// could not send raw bytes in the first place.
	const inputType = this.getNodeParameter('inputType', itemIndex) as string;
	const contentType = inputType === 'base64' ? 'text/plain' : sourceMediaType(sourceFormat);

	const response = await labelZoomRequest.call(this, {
		method: 'POST',
		// Rule A1: one endpoint covers every pair. Rule A2: `jpg` normalizes to
		// `jpeg` before the path is built, so `/convert/jpg/to/png` is never sent.
		path: `/api/v2/convert/${sourceWireToken(sourceFormat)}/to/${targetFormat}`,
		params: serializeConversionParams(this.getNode(), options),
		body: document,
		contentType,
	});

	const mimeType = contentTypeOf(response)?.split(';')[0].trim() ?? targetMediaType(targetFormat);
	const fileName = `label.${targetExtension(targetFormat)}`;

	const json: IDataObject = {
		sourceFormat,
		targetFormat,
		contentType: contentTypeOf(response),
		byteLength: response.body.length,
		requestId: requestIdOf(response),
	};

	// Only genuinely textual targets get a decoded convenience field. EPL, TSPL
	// and DPL come back as text/plain but can inline raw binary (EPL `GW`, TSPL
	// `BITMAP`, DPL's leading STX), so decoding them would corrupt any label
	// carrying graphics. Those stay binary-only.
	if (isTextualTarget(targetFormat)) {
		json.text = decodeText(response);
	}

	return {
		json,
		binary: {
			[outputBinaryPropertyName]: await this.helpers.prepareBinaryData(
				response.body,
				fileName,
				mimeType,
			),
		},
		pairedItem: { item: itemIndex },
	};
}
