import { isDefaultThemeId, type ThemeId } from './themes.js';

const pendingStylesheets = new Map<ThemeId, Promise<void>>();

// Returns synchronously when the profile sheet already participates in the cascade.
export function loadThemeStyles(id: ThemeId): Promise<void> | undefined {
	if (isDefaultThemeId(id)) return;
	const previous = pendingStylesheets.get(id);
	if (previous) return previous;

	const bootstrap = document.getElementById('garcon-theme-stylesheets');
	const href = bootstrap
		? (JSON.parse(bootstrap.textContent ?? '{}') as Partial<Record<ThemeId, string>>)[id]
		: undefined;
	const url =
		href ??
		(import.meta.env.DEV && import.meta.env.MODE !== 'test'
			? `/src/lib/theme/profiles/${id}.css?direct`
			: undefined);
	if (!url) return;

	const existing = document.head.querySelector<HTMLLinkElement>(`link[data-garcon-theme="${id}"]`);
	if (existing?.sheet) return;
	// By CSR start, a parser-inserted boot link has either loaded or failed.
	existing?.remove();

	const link = document.createElement('link');
	link.rel = 'stylesheet';
	link.dataset.garconTheme = id;
	link.href = url;
	const loading = new Promise<void>((resolve, reject) => {
		link.addEventListener('load', () => resolve(), { once: true });
		link.addEventListener(
			'error',
			() => {
				link.remove();
				reject(new Error(`Unable to load theme stylesheet: ${id}`));
			},
			{ once: true },
		);
	}).finally(() => {
		pendingStylesheets.delete(id);
	});
	pendingStylesheets.set(id, loading);
	if (bootstrap) bootstrap.after(link);
	else document.head.prepend(link);
	return loading;
}
