import {
	assignApiProvider,
	deleteApiProvider,
	getApiProviderManagement,
	unassignApiProvider,
} from '$lib/api/api-providers.js';
import type { ApiProviderManagement } from '$shared/api-providers';

export class ApiProvidersStore {
	snapshot = $state.raw<ApiProviderManagement | null>(null);
	error = $state<string | null>(null);
	loading = $state(false);
	mutating = $state(false);
	#version = 0;
	#consumers = 0;
	#request: Promise<void> | null = null;

	constructor(
		private readonly invalidateCatalogs: () => void,
		private readonly api = {
			read: getApiProviderManagement,
			assign: assignApiProvider,
			unassign: unassignApiProvider,
			delete: deleteApiProvider,
		},
	) {}

	get providers() {
		return this.snapshot?.providers ?? [];
	}

	isAssigned(nodeId: string, providerId: string): boolean {
		return this.snapshot?.assignments.assignments[nodeId]?.includes(providerId) === true;
	}

	findEndpoint(endpointId: string) {
		for (const apiProvider of this.providers) {
			const endpoint = apiProvider.endpoints.find((entry) => entry.id === endpointId);
			if (endpoint) return { apiProvider, endpoint };
		}
		return null;
	}

	retain(): () => void {
		this.#consumers++;
		void this.refresh();
		return () => {
			this.#consumers--;
		};
	}

	invalidate(): void {
		this.#version++;
		this.#request = null;
		this.invalidateCatalogs();
		if (this.#consumers) void this.refresh();
	}

	refresh(): Promise<void> {
		if (this.#request) return this.#request;
		const version = this.#version;
		this.loading = true;
		this.#request = this.api
			.read()
			.then((snapshot) => {
				if (version !== this.#version) return;
				this.snapshot = snapshot;
				this.error = null;
			})
			.catch((error: unknown) => {
				if (version === this.#version)
					this.error = error instanceof Error ? error.message : String(error);
			})
			.finally(() => {
				if (version === this.#version) {
					this.loading = false;
					this.#request = null;
				}
			});
		return this.#request;
	}

	async setAssignment(nodeId: string, providerId: string, assigned: boolean): Promise<void> {
		await this.#mutate(() =>
			assigned ? this.api.assign(nodeId, providerId) : this.api.unassign(nodeId, providerId),
		);
	}

	async deleteProfile(providerId: string): Promise<void> {
		await this.#mutate(() => this.api.delete(providerId));
	}

	async #mutate(operation: () => Promise<unknown>): Promise<void> {
		if (this.mutating) return;
		this.mutating = true;
		this.error = null;
		try {
			await operation();
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			// Even a failed response may follow a durable mutation.
			const error = this.error;
			this.invalidate();
			await this.refresh();
			this.error ??= error;
			this.mutating = false;
		}
	}
}
