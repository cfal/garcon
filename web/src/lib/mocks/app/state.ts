// SvelteKit $app/state mock for unit tests.

export const page = {
	url: new URL('http://localhost'),
	params: {} as Record<string, string>,
	route: { id: '' },
	status: 200,
	error: null,
	data: {},
	form: null,
};
