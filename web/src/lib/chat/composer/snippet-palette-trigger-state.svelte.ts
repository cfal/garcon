import type { SnippetTrigger } from './snippet-trigger.js';

export class SnippetPaletteTriggerState {
	isOpen = $state(false);
	trigger = $state<SnippetTrigger | null>(null);
	initialQuery = $state('');
	#activePrefix = '';
	#dismissedOccurrence: { start: number; prefix: string } | null = null;

	openFromMenu(): void {
		this.#open(null, '');
	}

	updateDetectedTrigger(trigger: SnippetTrigger | null, sourceText: string): void {
		this.#clearDismissalWhenPrefixIsRemoved(sourceText);
		if (!trigger) {
			if (this.trigger) this.complete();
			return;
		}
		this.#open(trigger, sourceText);
	}

	// Modal inertness prevents composer input or menu opens while a hidden trigger backs the argument chain.
	hide(): void {
		this.isOpen = false;
	}

	dismiss(): void {
		if (this.trigger) {
			this.#dismissedOccurrence = { start: this.trigger.start, prefix: this.#activePrefix };
		}
		this.complete();
	}

	complete(): void {
		this.isOpen = false;
		this.trigger = null;
		this.initialQuery = '';
		this.#activePrefix = '';
	}

	reset(): void {
		this.complete();
		this.#dismissedOccurrence = null;
	}

	#open(trigger: SnippetTrigger | null, sourceText: string): void {
		if (this.isOpen) return;
		if (trigger && trigger.start === this.#dismissedOccurrence?.start) return;
		this.trigger = trigger;
		this.#activePrefix = trigger
			? sourceText.slice(trigger.start, trigger.end - trigger.query.length)
			: '';
		this.initialQuery = trigger?.query ?? '';
		this.isOpen = true;
	}

	#clearDismissalWhenPrefixIsRemoved(sourceText: string): void {
		const dismissed = this.#dismissedOccurrence;
		if (!dismissed) return;
		if (sourceText.startsWith(dismissed.prefix, dismissed.start)) return;
		this.#dismissedOccurrence = null;
	}
}
