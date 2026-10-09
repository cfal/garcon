import { untrack } from 'svelte';
import type { Attachment } from 'svelte/attachments';
import type { HTMLTextareaAttributes } from 'svelte/elements';

/** Measures the height that shows every line, never less than the field's resting `rows`. */
export function measureTextareaHeight(target: HTMLTextAreaElement): number {
	const previousHeight = target.style.height;
	const previousScroll = target.scrollTop;
	const styles = getComputedStyle(target);
	const borders =
		styles.boxSizing === 'border-box'
			? (Number.parseFloat(styles.borderTopWidth) || 0) +
				(Number.parseFloat(styles.borderBottomWidth) || 0)
			: 0;
	// Releases the previous height so deleting text shrinks the field back to its rows.
	target.style.height = 'auto';
	const height = target.scrollHeight + borders;
	target.style.height = previousHeight;
	target.scrollTop = previousScroll;
	return height;
}

function fitTextareaToContent(target: HTMLTextAreaElement): void {
	target.style.height = `${measureTextareaHeight(target)}px`;
}

/**
 * Sizes a textarea to its content. The `rows` attribute sets the resting height and CSS
 * `max-height` sets the cap beyond which the field scrolls.
 */
export function contentSizedTextarea(
	getValue: () => HTMLTextareaAttributes['value'],
	resize: (target: HTMLTextAreaElement) => void = fitTextareaToContent,
): Attachment<HTMLTextAreaElement> {
	return (target) => {
		const initialHeight = target.style.height;
		let width = -1;
		let frame: number | null = null;
		function scheduleResize(): void {
			if (frame !== null) return;
			frame = requestAnimationFrame(() => {
				frame = null;
				resize(target);
			});
		}
		$effect(() => {
			getValue();
			untrack(() => resize(target));
		});
		// Covers rewrapping and a hidden field becoming visible.
		const observer = new ResizeObserver(([entry]) => {
			if (!entry || entry.contentRect.width === width) return;
			width = entry.contentRect.width;
			scheduleResize();
		});
		observer.observe(target);
		// A breakpoint can change the font size while the field keeps its width.
		window.addEventListener('resize', scheduleResize);
		return () => {
			observer.disconnect();
			window.removeEventListener('resize', scheduleResize);
			if (frame !== null) cancelAnimationFrame(frame);
			target.style.height = initialHeight;
		};
	};
}
