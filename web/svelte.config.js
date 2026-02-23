import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		runes: true
	},
	kit: {
		adapter: adapter({
			fallback: 'index.html'
		}),
		alias: {
			$shared: '../common'
		},
		prerender: {
			entries: []
		}
	}
};

export default config;
