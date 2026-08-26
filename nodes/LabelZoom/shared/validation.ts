import type { INode } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

/**
 * A local, pre-flight validation failure — a value the API is certain to reject,
 * caught before a request is made.
 *
 * It carries the *contract's* parameter name (`rotation`, `data`, `body`) rather
 * than the n8n field label, so the shared conformance fixtures can assert which
 * parameter was at fault. Extending NodeOperationError keeps it a first-class n8n
 * error in the UI: the node name, the item index and the description all render
 * exactly as they would otherwise.
 */
export class LabelZoomValidationError extends NodeOperationError {
	readonly parameter: string;

	constructor(
		node: INode,
		parameter: string,
		message: string,
		options?: { itemIndex?: number; description?: string },
	) {
		super(node, message, options);
		this.parameter = parameter;
	}
}
