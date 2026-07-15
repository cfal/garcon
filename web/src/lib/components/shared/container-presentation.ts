import type { Attachment } from 'svelte/attachments';

export type ContainerPresentation = 'narrow' | 'compact' | 'wide';

export interface ContainerPresentationBreakpoints {
	compactMinWidth: number;
	wideMinWidth: number;
}

export function containerPresentationForWidth(
	width: number,
	breakpoints: ContainerPresentationBreakpoints,
): ContainerPresentation {
	if (width >= breakpoints.wideMinWidth) return 'wide';
	if (width >= breakpoints.compactMinWidth) return 'compact';
	return 'narrow';
}

export function observeContainerWidth(onWidth: (width: number) => void): Attachment<HTMLElement> {
	return (element) => {
		let lastWidth = -1;
		const publish = (width: number): void => {
			if (!Number.isFinite(width) || width < 0 || width === lastWidth) return;
			lastWidth = width;
			onWidth(width);
		};

		publish(element.getBoundingClientRect().width);
		if (typeof ResizeObserver === 'undefined') return;

		const observer = new ResizeObserver(([entry]) => {
			if (entry) publish(entry.contentRect.width);
		});
		observer.observe(element);
		return () => observer.disconnect();
	};
}
