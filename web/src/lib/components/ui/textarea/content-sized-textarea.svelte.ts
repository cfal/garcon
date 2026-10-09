import { untrack } from 'svelte';
import type { Attachment } from 'svelte/attachments';
import type { HTMLTextareaAttributes } from 'svelte/elements';

function fitTextareaToContent(target: HTMLTextAreaElement): void {
	// A field without a layout box measures as empty; its reveal brings the next fit.
	if (target.getClientRects().length === 0) return;
	const { width, marginBottom, overflowY } = target.style;
	const scrollTop = target.scrollTop;
	const styles = getComputedStyle(target);
	const borders =
		styles.boxSizing === 'border-box'
			? (Number.parseFloat(styles.borderTopWidth) || 0) +
				(Number.parseFloat(styles.borderBottomWidth) || 0)
			: 0;
	// Keeps wrapping stable if the reserved space gives an ancestor a scrollbar.
	target.style.width = styles.width;
	// Holds the released height as margin so the layout around the field never shrinks
	// mid-measurement; a scrolled ancestor would clamp its position and not get it back.
	target.style.marginBottom = `calc(${styles.marginBottom} + ${target.offsetHeight}px)`;
	// A collapsed field would show a scrollbar that narrows the text and can add a line.
	target.style.overflowY = 'hidden';
	// Releases the previous height so deleting text shrinks the field back to its rows.
	target.style.height = 'auto';
	// Applies the fit before restoring scrollbars so wrapping cannot retain an old scrollbar.
	target.style.height = `${target.scrollHeight + borders}px`;
	target.style.overflowY = overflowY;
	target.style.marginBottom = marginBottom;
	target.style.width = width;
	target.scrollTop = scrollTop;
}

/**
 * Sizes a textarea to its content. The `rows` attribute sets the resting height and CSS
 * `max-height` sets the cap beyond which the field scrolls.
 */
export function contentSizedTextarea(
	getValue: () => HTMLTextareaAttributes['value'],
): Attachment<HTMLTextAreaElement> {
	return (target) => {
		const initialHeight = target.style.height;
		let width = -1;
		let frame: number | null = null;
		function scheduleResize(): void {
			if (frame !== null) return;
			frame = requestAnimationFrame(() => {
				frame = null;
				fitTextareaToContent(target);
			});
		}
		$effect(() => {
			getValue();
			untrack(() => fitTextareaToContent(target));
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
