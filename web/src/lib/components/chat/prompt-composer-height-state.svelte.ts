export const COMPOSER_DEFAULT_HEIGHT = 140;
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
		const renderedHeight = target.style.height;
		// Releases the constraint only for measurement; rendered height remains state-owned.
		target.style.height = 'auto';
		const maximum = isMobile ? MOBILE_CONTENT_MAX_HEIGHT : DESKTOP_CONTENT_MAX_HEIGHT;
		const measuredHeight = Math.max(
			COMPOSER_CONTENT_MIN_HEIGHT,
			Math.min(target.scrollHeight, maximum),
		);
		target.style.height = renderedHeight;
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
