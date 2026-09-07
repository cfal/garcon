import { DEFAULT_APP_TITLE } from '$shared/settings';
import { isRecord } from '$shared/json';

export interface PublicAppTitle {
	title: string;
	version: number;
}

const DEFAULT_TITLE_BOOTSTRAP: PublicAppTitle = {
	title: DEFAULT_APP_TITLE,
	version: 0,
};

function bootstrapTitle(): PublicAppTitle {
	const raw = globalThis.__GARCON_APP_TITLE__;
	if (!isRecord(raw)) return DEFAULT_TITLE_BOOTSTRAP;
	const title =
		typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : DEFAULT_APP_TITLE;
	const version =
		typeof raw.version === 'number' && Number.isSafeInteger(raw.version) ? raw.version : 0;
	return { title, version };
}

export class AppTitleStore {
	#bootstrap = bootstrapTitle();

	get title(): string {
		return this.#bootstrap.title;
	}

	get version(): number {
		return this.#bootstrap.version;
	}
}

export function createAppTitleStore(): AppTitleStore {
	return new AppTitleStore();
}
