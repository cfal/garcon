const resizeId = 'dialog-resize';
const pendingFrames = new WeakMap<HTMLElement, number>();
const activeResizes = new WeakMap<HTMLElement, Animation>();

export function cancelResizeOnUnmount(dialog: HTMLElement): () => void {
	return () => {
		const frame = pendingFrames.get(dialog);
		if (frame !== undefined) {
			cancelAnimationFrame(frame);
			pendingFrames.delete(dialog);
		}
		activeResizes.get(dialog)?.cancel();
	};
}

function canResize(dialog: HTMLElement, reducedMotion: MediaQueryList): boolean {
	const root = document.documentElement;
	return (
		dialog.isConnected &&
		dialog.dataset.state === 'open' &&
		!root.hasAttribute('data-reduce-motion') &&
		root.dataset.themeAppearance !== 'terminal' &&
		!reducedMotion.matches
	);
}

function watchResize(
	dialog: HTMLElement,
	resize: Animation,
	reducedMotion: MediaQueryList,
	viewport: VisualViewport | null,
): void {
	activeResizes.set(dialog, resize);
	const cancel = () => resize.cancel();
	const check = () => {
		if (!canResize(dialog, reducedMotion)) cancel();
	};
	// A closing dialog must not retain its interaction lock waiting for size motion.
	const observer = new MutationObserver(check);
	observer.observe(dialog, { attributeFilter: ['data-state'] });
	observer.observe(document.documentElement, {
		attributeFilter: ['data-reduce-motion', 'data-theme-appearance'],
	});
	const listeners = new AbortController();
	reducedMotion.addEventListener('change', check, { signal: listeners.signal });
	viewport?.addEventListener('resize', cancel, { signal: listeners.signal });
	const release = () => {
		if (activeResizes.get(dialog) === resize) activeResizes.delete(dialog);
		observer.disconnect();
		listeners.abort();
	};
	void resize.finished.then(release, release);
}

/** Captures the rendered box before a mode change, including a resize already in progress. */
export function animateDialogResize(dialog: HTMLElement | null): void {
	if (!dialog?.animate || pendingFrames.has(dialog)) return;
	const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
	if (!canResize(dialog, reducedMotion)) return;
	const width = dialog.offsetWidth;
	const height = dialog.offsetHeight;
	const viewport = window.visualViewport;
	const viewportWidth = viewport?.width;
	const viewportHeight = viewport?.height;

	// Measures the new mode after Svelte applies its layout.
	const frame = requestAnimationFrame(() => {
		pendingFrames.delete(dialog);
		activeResizes.get(dialog)?.cancel();
		if (
			!canResize(dialog, reducedMotion) ||
			viewport?.width !== viewportWidth ||
			viewport?.height !== viewportHeight
		)
			return;

		const nextWidth = dialog.offsetWidth;
		const nextHeight = dialog.offsetHeight;
		if (width === nextWidth && height === nextHeight) return;
		const dimensions: PropertyIndexedKeyframes = {};
		if (width !== nextWidth) dimensions.width = [`${width}px`, `${nextWidth}px`];
		if (height !== nextHeight) dimensions.height = [`${height}px`, `${nextHeight}px`];
		const resize = dialog.animate(dimensions, { id: resizeId, duration: 200, easing: 'ease' });
		watchResize(dialog, resize, reducedMotion, viewport);
	});
	pendingFrames.set(dialog, frame);
}

export function resizeDialogOnClick(event: MouseEvent): void {
	if (event.currentTarget instanceof Element) {
		animateDialogResize(event.currentTarget.closest<HTMLElement>('[data-slot="dialog-content"]'));
	}
}
