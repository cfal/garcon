import { createContext } from 'svelte';

export interface RetainedRendererProvider {
	attach(): void | Promise<void>;
	detach(): void;
	focusPrimary(): void;
}

export class SurfaceFrameBridge {
	#provider: { token: symbol; value: RetainedRendererProvider } | null = null;
	#active = false;
	#activationGeneration = 0;
	#attached: { generation: number; token: symbol } | null = null;

	provideRenderer(provider: RetainedRendererProvider): () => void {
		const entry = { token: Symbol('surface-renderer'), value: provider };
		if (this.#provider && this.#attached?.token === this.#provider.token) {
			this.#provider.value.detach();
		}
		this.#provider = entry;
		this.#attached = null;
		if (this.#active) void this.#attachCurrent(this.#activationGeneration);
		return () => {
			if (this.#provider?.token !== entry.token) return;
			if (this.#attached?.token === entry.token) entry.value.detach();
			this.#provider = null;
			this.#attached = null;
		};
	}

	async activate(): Promise<void> {
		this.#active = true;
		const generation = ++this.#activationGeneration;
		await Promise.resolve();
		await this.#attachCurrent(generation);
	}

	deactivate(): void {
		if (!this.#active && !this.#attached) return;
		this.#active = false;
		this.#activationGeneration += 1;
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

	async #attachCurrent(generation: number): Promise<void> {
		if (!this.#active || generation !== this.#activationGeneration) return;
		const provider = this.#provider;
		if (!provider) return;
		if (this.#attached?.generation === generation && this.#attached.token === provider.token)
			return;
		this.#attached = { generation, token: provider.token };
		try {
			await provider.value.attach();
		} catch (error) {
			if (this.#attached?.generation === generation && this.#attached.token === provider.token)
				this.#attached = null;
			throw error;
		}
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
