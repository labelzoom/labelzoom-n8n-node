import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { getPrinters } from './listSearch/getPrinters';
import { getTemplates } from './listSearch/getTemplates';
import { convert, convertTemplate, labelDescription } from './resources/label';
import {
	getJob,
	getMany,
	getStatus,
	print,
	printTemplate,
	printerDescription,
} from './resources/printer';

/**
 * Run one operation for one item.
 *
 * Everything this can throw is already a NodeApiError or NodeOperationError
 * carrying the node, the item index and the LabelZoom request id, so callers must
 * let those propagate untouched rather than re-wrapping them.
 */
async function runOperation(
	this: IExecuteFunctions,
	resource: string,
	operation: string,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	if (resource === 'label') {
		if (operation === 'convert') return [await convert.call(this, itemIndex)];
		if (operation === 'convertTemplate') return [await convertTemplate.call(this, itemIndex)];
		throw new NodeOperationError(this.getNode(), `Unknown label operation: ${operation}`, {
			itemIndex,
		});
	}

	if (resource === 'printer') {
		if (operation === 'print') return [await print.call(this, itemIndex)];
		if (operation === 'printTemplate') return [await printTemplate.call(this, itemIndex)];
		if (operation === 'getJob') return [await getJob.call(this, itemIndex)];
		if (operation === 'getStatus') return [await getStatus.call(this, itemIndex)];
		if (operation === 'getMany') return await getMany.call(this, itemIndex);
		throw new NodeOperationError(this.getNode(), `Unknown printer operation: ${operation}`, {
			itemIndex,
		});
	}

	throw new NodeOperationError(this.getNode(), `Unknown resource: ${resource}`, { itemIndex });
}

export class LabelZoom implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'LabelZoom',
		name: 'labelZoom',
		icon: { light: 'file:../../icons/labelzoom.svg', dark: 'file:../../icons/labelzoom.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Convert barcode labels between formats and print them to thermal printers',
		defaults: { name: 'LabelZoom' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				// Plain conversion works anonymously on the free tier (watermarked),
				// so the node stays usable with no setup at all.
				name: 'labelZoomApi',
				required: false,
				displayOptions: { show: { resource: ['label'], operation: ['convert'] } },
			},
			{
				// Everything else reads or writes account-scoped data — a template
				// belongs to an account, and a print job goes to *your* printer — so
				// there is no anonymous equivalent and a missing credential should be
				// caught in the editor rather than as a 401 at run time.
				name: 'labelZoomApi',
				required: true,
				displayOptions: { show: { resource: ['label'], operation: ['convertTemplate'] } },
			},
			{
				name: 'labelZoomApi',
				required: true,
				displayOptions: { show: { resource: ['printer'] } },
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Label', value: 'label', description: 'Convert a label between formats' },
					{
						name: 'Printer',
						value: 'printer',
						description: 'Send labels to a cloud-connected printer (beta)',
					},
				],
				default: 'label',
			},
			...labelDescription,
			...printerDescription,
		],
	};

	methods = {
		listSearch: {
			getPrinters,
			getTemplates,
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;
		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			// Only the "continue on fail" path catches. On the normal path an error
			// propagates exactly as it was thrown, with its status code, hints and
			// request id intact — a catch-and-rethrow would flatten all of that.
			if (!this.continueOnFail()) {
				returnData.push(...(await runOperation.call(this, resource, operation, itemIndex)));
				continue;
			}

			try {
				returnData.push(...(await runOperation.call(this, resource, operation, itemIndex)));
			} catch (error) {
				returnData.push({
					json: { error: (error as Error).message },
					pairedItem: { item: itemIndex },
				});
			}
		}

		return [returnData];
	}
}
