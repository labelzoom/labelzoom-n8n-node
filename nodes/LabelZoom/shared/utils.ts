import type { IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { LabelZoomValidationError } from './validation';

/**
 * Read the document to send from the current item — either a binary attachment
 * or an inline string.
 *
 * Everything is returned as a Buffer. The API takes the raw document as the
 * request body; `application/x-www-form-urlencoded` and `multipart/form-data` are
 * not supported, so there is never a form to build.
 */
export async function readDocument(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<Buffer> {
	const inputType = this.getNodeParameter('inputType', itemIndex) as string;

	if (inputType === 'text' || inputType === 'base64') {
		const content = this.getNodeParameter('labelContent', itemIndex) as string;
		if (content === '') {
			// The API rejects a zero-length body with a 400 before it looks at
			// anything else, so there is nothing to learn from sending it.
			throw new LabelZoomValidationError(this.getNode(), 'body', 'Label Content is empty', {
				itemIndex,
			});
		}
		return Buffer.from(content, 'utf8');
	}

	const binaryPropertyName = this.getNodeParameter('binaryPropertyName', itemIndex) as string;
	// Throws a clear "no binary data named X" error of its own if absent.
	this.helpers.assertBinaryData(itemIndex, binaryPropertyName);
	const buffer = await this.helpers.getBinaryDataBuffer(itemIndex, binaryPropertyName);
	if (buffer.length === 0) {
		throw new LabelZoomValidationError(
			this.getNode(),
			'body',
			`The binary field "${binaryPropertyName}" is empty`,
			{ itemIndex },
		);
	}
	return buffer;
}

/**
 * Resolve a resourceLocator parameter to its plain id.
 *
 * Both printers and templates are referenced by UUID; there is no by-name lookup
 * endpoint, so "From List" resolves a name to an id at design time and the value
 * stored in the workflow is always the id.
 */
export function resourceId(
	this: IExecuteFunctions,
	parameterName: string,
	itemIndex: number,
): string {
	const value = this.getNodeParameter(parameterName, itemIndex, undefined, {
		extractValue: true,
	}) as string;
	if (typeof value !== 'string' || value.trim() === '') {
		throw new NodeOperationError(this.getNode(), `No ${parameterName} was provided`, { itemIndex });
	}
	return value.trim();
}
