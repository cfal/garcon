export interface FixedVirtualWindowOptions {
	readonly itemCount: number;
	readonly rowHeight: number;
	readonly overscan: number;
	readonly viewportRef: HTMLElement | null;
	readonly bottomPadding?: number;
	readonly defaultViewportHeight?: number;
}

export class FixedVirtualWindow {
	scrollTop = $state(0);
	viewportHeight = $state(640);

	#options: FixedVirtualWindowOptions;

	constructor(options: FixedVirtualWindowOptions) {
		this.#options = options;
		this.viewportHeight = options.defaultViewportHeight ?? 640;
	}

	get itemCount(): number {
		return Math.max(0, this.#options.itemCount);
	}

	get rowHeight(): number {
		return Math.max(1, this.#options.rowHeight);
	}

	get overscan(): number {
		return Math.max(0, this.#options.overscan);
	}

	get bottomPadding(): number {
		return Math.max(0, this.#options.bottomPadding ?? 0);
	}

	get totalHeight(): number {
		return this.itemCount * this.rowHeight + this.bottomPadding;
	}

	get startIndex(): number {
		return Math.min(
			this.itemCount,
			Math.max(0, Math.floor(this.scrollTop / this.rowHeight) - this.overscan),
		);
	}

	get endIndex(): number {
		const visibleEnd = Math.ceil((this.scrollTop + this.viewportHeight) / this.rowHeight);
		return Math.min(this.itemCount, visibleEnd + this.overscan);
	}

	get visibleIndexes(): number[] {
		const indexes: number[] = [];
		for (let index = this.startIndex; index < this.endIndex; index += 1) {
			indexes.push(index);
		}
		return indexes;
	}

	getOffset(index: number): number {
		return index * this.rowHeight;
	}

	bindViewport(): () => void {
		const viewport = this.#options.viewportRef;
		if (!viewport) return () => {};

		const handleScroll = () => {
			this.scrollTop = viewport.scrollTop;
		};

		viewport.addEventListener('scroll', handleScroll, { passive: true });
		this.scrollTop = viewport.scrollTop;
		this.viewportHeight = Math.max(this.rowHeight, viewport.clientHeight || this.viewportHeight);

		return () => viewport.removeEventListener('scroll', handleScroll);
	}

	observeViewport(): () => void {
		const viewport = this.#options.viewportRef;
		if (!viewport || typeof ResizeObserver === 'undefined') return () => {};

		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				this.viewportHeight = Math.max(this.rowHeight, entry.contentRect.height);
			}
		});
		observer.observe(viewport);

		return () => observer.disconnect();
	}

	scrollIndexIntoView(index: number, anchorRatio = 0.2): void {
		const viewport = this.#options.viewportRef;
		if (!viewport || index < 0 || index >= this.itemCount) return;

		const top = index * this.rowHeight;
		const bottom = top + this.rowHeight;
		const viewportBottom = viewport.scrollTop + this.viewportHeight;

		if (top >= viewport.scrollTop && bottom <= viewportBottom) return;

		viewport.scrollTop = Math.max(0, top - this.viewportHeight * anchorRatio);
		this.scrollTop = viewport.scrollTop;
	}
}
