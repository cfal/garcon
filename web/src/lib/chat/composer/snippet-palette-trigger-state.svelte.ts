import type { SnippetTrigger } from './snippet-trigger.js';

export class SnippetPaletteTriggerState {
	isOpen = $state(false);
	trigger = $state<SnippetTrigger | null>(null);
	initialQuery = $state('');
	#dismissedTriggerStart: number | null = null;

	openFromMenu(): void {
		this.#open(null);
	}

	updateDetectedTrigger(trigger: SnippetTrigger | null): void {
		if (!trigger) {
			this.#dismissedTriggerStart = null;
			if (this.trigger) this.complete();
			return;
		}
		this.#open(trigger);
	}

	// Modal inertness prevents composer input or menu opens while a hidden trigger backs the argument chain.
	hide(): void {
		this.isOpen = false;
	}

	dismiss(): void {
		if (this.trigger) this.#dismissedTriggerStart = this.trigger.start;
		this.complete();
	}

	complete(): void {
		this.isOpen = false;
		this.trigger = null;
		this.initialQuery = '';
	}

	reset(): void {
		this.complete();
		this.#dismissedTriggerStart = null;
	}

	#open(trigger: SnippetTrigger | null): void {
		if (this.isOpen) return;
		if (trigger && trigger.start === this.#dismissedTriggerStart) return;
		this.trigger = trigger;
		this.initialQuery = trigger?.query ?? '';
		this.isOpen = true;
	}
}
