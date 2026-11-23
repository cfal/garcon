const resizeId = 'dialog-resize';
const pendingFrames = new WeakSet<HTMLElement>();

function canResize(dialog: HTMLElement, reducedMotion: MediaQueryList): boolean {
	const root = document.documentElement;
	return (
		dialog.isConnected &&
		dialog.dataset.state === 'open' &&
		dialog.dataset.resizeMotion !== 'none' &&
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
	const cancel = () => resize.cancel();
	const check = () => {
		if (!canResize(dialog, reducedMotion)) cancel();
	};
	// A closing dialog must not retain its interaction lock waiting for size motion.
	const observer = new MutationObserver(check);
	observer.observe(dialog, { attributeFilter: ['data-state', 'data-resize-motion'] });
	observer.observe(document.documentElement, {
		attributeFilter: ['data-reduce-motion', 'data-theme-appearance'],
	});
	const listeners = new AbortController();
	reducedMotion.addEventListener('change', check, { signal: listeners.signal });
	viewport?.addEventListener('resize', cancel, { signal: listeners.signal });
	const release = () => {
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
	pendingFrames.add(dialog);
	const width = dialog.offsetWidth;
	const height = dialog.offsetHeight;
	const viewport = window.visualViewport;
	const viewportWidth = viewport?.width;
	const viewportHeight = viewport?.height;

	// The next frame includes both Svelte updates and native summary activation.
	requestAnimationFrame(() => {
		pendingFrames.delete(dialog);
		dialog
			.getAnimations()
			.find((animation) => animation.id === resizeId)
			?.cancel();
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
		if (height !== nextHeight) {
			dimensions.height = [`${height}px`, `${nextHeight}px`];
			// Avoids a temporary scrollbar rewrapping content that fits at its natural height.
			if (dialog.scrollHeight <= dialog.clientHeight) dimensions.overflowY = ['hidden', 'hidden'];
		}
		const resize = dialog.animate(dimensions, { id: resizeId, duration: 200, easing: 'ease' });
		watchResize(dialog, resize, reducedMotion, viewport);
	});
}

export function resizeDialogOnClick(event: MouseEvent): void {
	if (event.currentTarget instanceof Element) {
		animateDialogResize(event.currentTarget.closest<HTMLElement>('[data-slot="dialog-content"]'));
	}
}
