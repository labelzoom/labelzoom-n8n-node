import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class LabelZoomApi implements ICredentialType {
	name = 'labelZoomApi';

	displayName = 'LabelZoom API';

	icon: Icon = { light: 'file:../icons/labelzoom.svg', dark: 'file:../icons/labelzoom.dark.svg' };

	documentationUrl = 'https://docs.labelzoom.com/getting-started/authentication/';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description:
				'Your LabelZoom API key, from the API Access section of your dashboard. Conversion also works without a key on the free tier, but output is watermarked and printing requires a key with the "print" scope.',
		},
		{
			displayName: 'Max Retries',
			name: 'maxRetries',
			type: 'number',
			typeOptions: { minValue: 0, maxValue: 5 },
			default: 2,
			description:
				'How many times to retry a rate limit (429) or a server error (5xx), with exponential backoff. Set to 0 to fail fast. Client errors are never retried.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.labelzoom.com',
			description: 'Only change this if you were given a dedicated endpoint',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	/**
	 * Validate the key against the template registry rather than the conversion
	 * endpoint.
	 *
	 * Two reasons. It costs no conversion quota. And more importantly, the
	 * conversion endpoint does NOT reject an unknown key — the gateway passes a
	 * key it cannot resolve straight through to the backend, which treats the
	 * request as anonymous and happily returns a watermarked label. Testing there
	 * would report a typo'd key as valid.
	 *
	 * This endpoint needs only the `convert` scope, which every key has: `print`
	 * implies `convert`, and `convert` is the default for a newly created key.
	 */
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/api/v3/templates',
			method: 'GET',
			headers: { Accept: '*/*' },
		},
	};
}
