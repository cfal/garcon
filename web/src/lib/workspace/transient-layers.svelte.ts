import type { ChatInteractionGate } from './chat-interaction-gate.svelte.js';
import { untrack } from 'svelte';

export type TransientLayerKind =
	| 'menu'
	| 'popover'
	| 'confirmation'
	| 'prompt-transform'
	| 'application-dialog'
	| 'file-dialog'
	| 'sidebar-overlay'
	| 'other';

export type TransientLayerModality = 'nonmodal' | 'main-inert';

export interface TransientLayerRegistration {
	id: string;
	kind: TransientLayerKind;
	modality: TransientLayerModality;
	element: () => HTMLElement | null;
	onEscape: () => boolean;
	restoreFocus: () => void;
}

interface RegisteredLayer extends TransientLayerRegistration {
	sequence: number;
}

interface PendingMainInertLayer {
	id: symbol;
	timer: ReturnType<typeof setTimeout> | null;
}

const PRIORITY: Record<TransientLayerKind, number> = {
	menu: 5,
	popover: 5,
	confirmation: 4,
	'prompt-transform': 3,
	'application-dialog': 3,
	'file-dialog': 3,
	'sidebar-overlay': 2,
	other: 1,
};

export class TransientLayerRegistry {
	#layers = $state.raw<readonly RegisteredLayer[]>([]);
	#pendingMainInert = $state(0);
	#pendingMainInertLayers: PendingMainInertLayer[] = [];
	#sequence = 0;

	constructor(private readonly chatInteractionGate: ChatInteractionGate) {
		this.#syncChatInertness();
	}

	get makesMainInert(): boolean {
		return (
			this.#pendingMainInert > 0 || this.#layers.some((layer) => layer.modality === 'main-inert')
		);
	}

	get hasPendingMainInert(): boolean {
		return this.#pendingMainInert > 0;
	}

	open<T>(modality: TransientLayerModality, commitOpen: () => T): T {
		if (modality !== 'main-inert') return commitOpen();
		this.chatInteractionGate.cancelBeforeInertTransition();
		const pending: PendingMainInertLayer = { id: Symbol('main-inert'), timer: null };
		this.#pendingMainInertLayers.push(pending);
		this.#pendingMainInert = this.#pendingMainInertLayers.length;
		this.#syncChatInertness();
		let result: T;
		try {
			result = commitOpen();
		} catch (error) {
			this.#releasePending(pending);
			throw error;
		}
		if (result && typeof (result as { then?: unknown }).then === 'function') {
			return Promise.resolve(result).then(
				(value) => {
					this.#schedulePendingFallback(pending);
					return value;
				},
				(error) => {
					this.#releasePending(pending);
					throw error;
				},
			) as T;
		}
		this.#schedulePendingFallback(pending);
		return result;
	}

	register(registration: TransientLayerRegistration): () => void {
		if (registration.modality === 'main-inert') this.#consumePending(false);
		const layer: RegisteredLayer = { ...registration, sequence: ++this.#sequence };
		this.#layers = [...untrack(() => this.#layers), layer];
		this.#syncChatInertness();
		return () => {
			this.#layers = untrack(() => this.#layers).filter((candidate) => candidate !== layer);
			this.#syncChatInertness();
		};
	}

	handleEscape(event: KeyboardEvent): boolean {
		if (event.key !== 'Escape') return false;
		const layer = this.#topVisibleLayer();
		if (!layer || !layer.onEscape()) return false;
		event.preventDefault();
		event.stopPropagation();
		queueMicrotask(layer.restoreFocus);
		return true;
	}

	ownsTopModalTarget(target: EventTarget | null): boolean {
		if (!(target instanceof Node)) return false;
		return Boolean(this.#topVisibleLayer('main-inert')?.element()?.contains(target));
	}

	#topVisibleLayer(modality?: TransientLayerModality): RegisteredLayer | null {
		return (
			this.#layers
				.filter((layer) => {
					if (modality && layer.modality !== modality) return false;
					const element = layer.element();
					return Boolean(element?.isConnected && !element.hidden);
				})
				.sort((left, right) => {
					const priority = PRIORITY[right.kind] - PRIORITY[left.kind];
					return priority || right.sequence - left.sequence;
				})[0] ?? null
		);
	}

	#consumePending(sync = true): void {
		const pending = this.#pendingMainInertLayers[0];
		if (pending) this.#releasePending(pending, sync);
	}

	#schedulePendingFallback(pending: PendingMainInertLayer): void {
		if (!this.#pendingMainInertLayers.includes(pending)) return;
		pending.timer = setTimeout(() => this.#releasePending(pending), 0);
	}

	#releasePending(pending: PendingMainInertLayer, sync = true): void {
		if (pending.timer) clearTimeout(pending.timer);
		this.#pendingMainInertLayers = this.#pendingMainInertLayers.filter(
			(candidate) => candidate !== pending,
		);
		this.#pendingMainInert = this.#pendingMainInertLayers.length;
		if (sync) this.#syncChatInertness();
	}

	#syncChatInertness(): void {
		this.chatInteractionGate.setMainInert(untrack(() => this.makesMainInert));
	}
}
