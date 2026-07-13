import { createContext } from 'svelte';

export interface RetainedRendererProvider {
	attach(): void | Promise<void>;
	detach(): void;
	focusPrimary(): void;
}

interface PendingActivation {
	generation: number;
	settled: boolean;
	resolve: () => void;
	reject: (error: unknown) => void;
}

export class SurfaceFrameBridge {
	#provider: { token: symbol; value: RetainedRendererProvider } | null = null;
	#active = false;
	#activationGeneration = 0;
	#attached: { generation: number; token: symbol } | null = null;
	#activation: PendingActivation | null = null;

	provideRenderer(provider: RetainedRendererProvider): () => void {
		const entry = { token: Symbol('surface-renderer'), value: provider };
		if (this.#provider && this.#attached?.token === this.#provider.token) {
			this.#provider.value.detach();
		}
		this.#provider = entry;
		this.#attached = null;
		if (this.#active) this.#attachCurrent(entry);
		return () => {
			if (this.#provider?.token !== entry.token) return;
			if (this.#attached?.token === entry.token) entry.value.detach();
			this.#provider = null;
			this.#attached = null;
		};
	}

	async activate(waitForProvider = true): Promise<void> {
		this.#cancelPendingActivation();
		this.#active = true;
		const generation = ++this.#activationGeneration;
		let resolve!: () => void;
		let reject!: (error: unknown) => void;
		const promise = new Promise<void>((resolvePromise, rejectPromise) => {
			resolve = resolvePromise;
			reject = rejectPromise;
		});
		const activation: PendingActivation = {
			generation,
			settled: false,
			resolve,
			reject,
		};
		this.#activation = activation;
		if (!waitForProvider) {
			activation.settled = true;
			activation.resolve();
		}
		const provider = this.#provider;
		if (provider) this.#attachCurrent(provider);
		return promise;
	}

	deactivate(): void {
		if (!this.#active && !this.#attached && !this.#activation) return;
		this.#active = false;
		this.#activationGeneration += 1;
		this.#cancelPendingActivation();
		const attached = this.#attached;
		this.#attached = null;
		if (this.#provider && attached?.token === this.#provider.token) {
			this.#provider.value.detach();
		}
	}

	focusPrimary(): boolean {
		if (!this.#provider) return false;
		this.#provider.value.focusPrimary();
		return true;
	}

	#attachCurrent(provider: { token: symbol; value: RetainedRendererProvider }): void {
		const activation = this.#activation;
		if (!this.#active || !activation || activation.settled) {
			void this.#reattachCurrent(provider);
			return;
		}
		if (
			this.#attached?.generation === activation.generation &&
			this.#attached.token === provider.token
		) {
			return;
		}
		this.#attached = { generation: activation.generation, token: provider.token };
		void Promise.resolve()
			.then(() => provider.value.attach())
			.then(
				() => {
					if (!this.#isCurrent(activation, provider.token)) {
						this.#detachQuietly(provider.value);
						return;
					}
					activation.settled = true;
					activation.resolve();
				},
				(error) => {
					if (!this.#isCurrent(activation, provider.token)) return;
					this.#attached = null;
					activation.settled = true;
					activation.reject(error);
				},
			)
			.catch(() => undefined);
	}

	async #reattachCurrent(provider: {
		token: symbol;
		value: RetainedRendererProvider;
	}): Promise<void> {
		if (!this.#active || this.#provider?.token !== provider.token) return;
		const generation = this.#activationGeneration;
		this.#attached = { generation, token: provider.token };
		try {
			await provider.value.attach();
			if (
				!this.#active ||
				this.#provider?.token !== provider.token ||
				this.#activationGeneration !== generation
			) {
				this.#detachQuietly(provider.value);
			}
		} catch {
			if (this.#attached?.generation === generation && this.#attached.token === provider.token) {
				this.#attached = null;
			}
		}
	}

	#isCurrent(activation: PendingActivation, providerToken: symbol): boolean {
		return (
			this.#active &&
			this.#activation === activation &&
			this.#activationGeneration === activation.generation &&
			this.#provider?.token === providerToken &&
			this.#attached?.generation === activation.generation &&
			this.#attached.token === providerToken
		);
	}

	#detachQuietly(provider: RetainedRendererProvider): void {
		try {
			provider.detach();
		} catch {
			// The owning activation has already been cancelled or replaced.
		}
	}

	#cancelPendingActivation(): void {
		const activation = this.#activation;
		if (!activation || activation.settled) return;
		activation.settled = true;
		activation.reject(new DOMException('Surface renderer activation was superseded', 'AbortError'));
	}
}

const [getSurfaceFrameBridgeFactory, setSurfaceFrameBridgeFactory] =
	createContext<() => SurfaceFrameBridge>();

export function getSurfaceFrameBridge(): SurfaceFrameBridge {
	return getSurfaceFrameBridgeFactory()();
}

export function setSurfaceFrameBridge(factory: () => SurfaceFrameBridge): void {
	setSurfaceFrameBridgeFactory(factory);
}
