// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	var __GARCON_APP_TITLE__:
		| import('$lib/stores/app-title.svelte').PublicAppTitle
		| undefined;

	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
