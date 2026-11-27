/** Coalesces invalidations while ensuring a read that predates them is followed by a fresh read. */
export class CatalogRefresh {
	#running: Promise<void> | null = null;
	#requested = false;

	constructor(
		private readonly refresh: () => Promise<unknown>,
		private readonly isLoading: () => boolean,
	) {}

	get pending(): Promise<void> | null {
		return this.#running;
	}

	request(): Promise<void> {
		this.#requested = true;
		return (this.#running ??= this.#drain());
	}

	async #drain(): Promise<void> {
		try {
			do {
				this.#requested = false;
				const joinedExistingLoad = this.isLoading();
				await runCatalogLoad(this.refresh);
				this.#requested ||= joinedExistingLoad;
			} while (this.#requested);
		} finally {
			this.#running = null;
		}
	}
}

export async function runCatalogLoad(load: () => Promise<unknown>): Promise<void> {
	try {
		await load();
	} catch {
		// Refresh failures are already exposed on the requesting store.
	}
}
