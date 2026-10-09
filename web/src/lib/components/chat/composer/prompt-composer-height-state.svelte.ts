import { measureTextareaHeight } from '$lib/components/ui/textarea/content-sized-textarea.svelte.js';

export const COMPOSER_DEFAULT_HEIGHT = 52;
export const COMPOSER_MIN_HEIGHT = 52;
export const COMPOSER_MAX_HEIGHT = 500;

const COMPOSER_CONTENT_MIN_HEIGHT = 48;
const MOBILE_CONTENT_MAX_HEIGHT = 150;
const DESKTOP_CONTENT_MAX_HEIGHT = 300;

function clampHeight(height: number): number {
	return Math.max(COMPOSER_MIN_HEIGHT, Math.min(COMPOSER_MAX_HEIGHT, height));
}

export class PromptComposerHeightState {
	#preferredHeight = $state(COMPOSER_DEFAULT_HEIGHT);
	#contentHeight = $state(COMPOSER_DEFAULT_HEIGHT);
	#previewHeight = $state<number | null>(null);

	get renderedHeight(): number {
		return this.#previewHeight ?? this.#contentHeight;
	}

	restorePreferredHeight(height: number): void {
		this.#preferredHeight = clampHeight(height);
		this.#contentHeight = this.#preferredHeight;
	}

	fitToContent(target: HTMLTextAreaElement, isMobile: boolean): void {
		const maximum = isMobile ? MOBILE_CONTENT_MAX_HEIGHT : DESKTOP_CONTENT_MAX_HEIGHT;
		const measuredHeight = Math.max(
			COMPOSER_CONTENT_MIN_HEIGHT,
			Math.min(measureTextareaHeight(target), maximum),
		);
		this.#contentHeight = isMobile
			? measuredHeight
			: Math.max(this.#preferredHeight, measuredHeight);
	}

	preview(height: number): void {
		this.#previewHeight = clampHeight(height);
	}

	cancelPreview(): void {
		this.#previewHeight = null;
	}

	commit(height: number): number {
		this.#preferredHeight = clampHeight(height);
		this.#contentHeight = this.#preferredHeight;
		this.#previewHeight = null;
		return this.#preferredHeight;
	}
}
