import type { INodeProperties } from 'n8n-workflow';

import { printDescription } from './print';
import { printTemplateDescription } from './printTemplate';
import { readsDescription } from './reads';

export { print } from './print';
export { printTemplate } from './printTemplate';
export { getJob, getMany, getStatus } from './reads';

export const printerDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['printer'] } },
		options: [
			{
				name: 'Get Job',
				value: 'getJob',
				description: 'Look up a print job by ID to see whether it printed',
				action: 'Get a print job',
			},
			{
				name: 'Get Many',
				value: 'getMany',
				description: 'List the printers on your account',
				action: 'Get many printers',
			},
			{
				name: 'Get Status',
				value: 'getStatus',
				description: 'Get one printer\'s live status and bound agents',
				action: 'Get a printer status',
			},
			{
				name: 'Print',
				value: 'print',
				description: 'Send a label to a cloud-connected printer, converting it in transit',
				action: 'Print a label',
			},
			{
				name: 'Print Template',
				value: 'printTemplate',
				description: 'Fill a Print Template with data and print it',
				action: 'Print a print template',
			},
		],
		default: 'print',
	},
	...printDescription,
	...printTemplateDescription,
	...readsDescription,
];
