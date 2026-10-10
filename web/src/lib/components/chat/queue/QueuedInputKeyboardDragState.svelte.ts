import type { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte.js';

interface KeyboardDragOptions {
	id: string;
	transientLayers: TransientLayerRegistry | null;
	get blocked(): boolean;
	get handle(): HTMLButtonElement | null;
	onMove: (direction: -1 | 1) => Promise<void>;
}

export class QueuedInputKeyboardDragState {
	#active = $state(false);
	#moving = false;

	constructor(private readonly options: KeyboardDragOptions) {
		$effect(() => {
			if (!this.#active || !options.transientLayers) return;
			return options.transientLayers.register({
				id: options.id,
				kind: 'other',
				modality: 'nonmodal',
				isOpen: () => this.#active,
				element: () => options.handle,
				onEscape: () => {
					this.finish();
					return true;
				},
				restoreFocus: () => {
					if (options.handle?.isConnected) options.handle.focus({ preventScroll: true });
				},
			});
		});
	}

	get active(): boolean {
		return this.#active;
	}

	toggle(): void {
		if (!this.options.blocked) this.#active = !this.#active;
	}

	finish(): void {
		this.#active = false;
	}

	handleBlur(): void {
		queueMicrotask(() => {
			const focused = document.activeElement;
			if (focused === this.options.handle) return;
			// Reordering connected rows can briefly move focus to the document body.
			if (focused === document.body && this.#moving) return;
			this.finish();
		});
	}

	handleKeydown(event: KeyboardEvent): void {
		if (event.isComposing || !this.#active) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			this.finish();
			return;
		}
		if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
		event.preventDefault();
		event.stopPropagation();
		if (!this.options.blocked && !this.#moving) void this.#move(event.key === 'ArrowUp' ? -1 : 1);
	}

	async #move(direction: -1 | 1): Promise<void> {
		this.#moving = true;
		try {
			await this.options.onMove(direction);
		} finally {
			this.#moving = false;
		}
	}
}
