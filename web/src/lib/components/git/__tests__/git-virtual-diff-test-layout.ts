import { vi } from 'vitest';

interface GitVirtualDiffTestLayoutOptions {
	readonly viewportHeight: number;
	readonly width?: number;
	rowHeight?(element: HTMLElement): number;
}

export interface GitVirtualDiffTestLayout {
	setViewportHeight(height: number): void;
}

function sizerHeight(viewport: HTMLElement): number {
	const sizer = viewport.querySelector<HTMLElement>('[data-git-virtual-diff-sizer]');
	return Number.parseFloat(sizer?.style.height ?? '0') || 0;
}

export function installGitVirtualDiffTestLayout(
	options: GitVirtualDiffTestLayoutOptions,
): GitVirtualDiffTestLayout {
	const width = options.width ?? 1024;
	const rowHeight = options.rowHeight ?? (() => 42);
	let viewportHeight = options.viewportHeight;
	const heightFor = (element: HTMLElement): number =>
		element.hasAttribute('data-git-virtual-diff-root')
			? viewportHeight
			: element.hasAttribute('data-git-virtual-diff-sizer')
				? Number.parseFloat(element.style.height) || 0
				: rowHeight(element);

	vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(width);
	vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
		this: HTMLElement,
	) {
		return heightFor(this);
	});
	vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
		this: HTMLElement,
	) {
		return heightFor(this);
	});
	vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
		this: HTMLElement,
	) {
		return this.hasAttribute('data-git-virtual-diff-root')
			? Math.max(viewportHeight, sizerHeight(this))
			: heightFor(this);
	});
	vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
		this: HTMLElement,
	) {
		const height = heightFor(this);
		const top = this.hasAttribute('data-git-virtual-diff-sizer')
			? -(this.parentElement?.scrollTop ?? 0)
			: 0;
		return {
			width,
			height,
			top,
			right: width,
			bottom: top + height,
			left: 0,
			x: 0,
			y: top,
			toJSON: () => ({}),
		};
	});

	return {
		setViewportHeight(height) {
			viewportHeight = height;
		},
	};
}
