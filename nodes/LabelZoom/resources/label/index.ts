import type { INodeProperties } from 'n8n-workflow';

import { convertDescription } from './convert';
import { convertTemplateDescription } from './convertTemplate';

export { convert } from './convert';
export { convertTemplate } from './convertTemplate';

export const labelDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['label'] } },
		options: [
			{
				name: 'Convert',
				value: 'convert',
				description: 'Convert a label between ZPL, EPL, TSPL, DPL, PDF, images and XML/JSON',
				action: 'Convert a label',
			},
			{
				name: 'Convert Template',
				value: 'convertTemplate',
				description: 'Fill a Print Template with data and render it, without printing',
				action: 'Convert a print template',
			},
		],
		default: 'convert',
	},
	...convertDescription,
	...convertTemplateDescription,
];
