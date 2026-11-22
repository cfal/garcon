const resizeId = 'dialog-resize';
const pendingFrames = new WeakSet<HTMLElement>();

function skipResizeMotion(): boolean {
	const root = document.documentElement;
	return (
		root.hasAttribute('data-reduce-motion') ||
		root.dataset.themeAppearance === 'terminal' ||
		window.matchMedia('(prefers-reduced-motion: reduce)').matches
	);
}

/** Captures the rendered box before a mode change, including a resize already in progress. */
export function animateDialogResize(dialog: HTMLElement | null): void {
	if (!dialog?.animate || skipResizeMotion() || pendingFrames.has(dialog)) return;
	pendingFrames.add(dialog);
	const width = dialog.offsetWidth;
	const height = dialog.offsetHeight;
	const viewport = window.visualViewport;
	const viewportWidth = viewport?.width;
	const viewportHeight = viewport?.height;

	// The next frame includes both Svelte updates and native summary activation.
	requestAnimationFrame(() => {
		pendingFrames.delete(dialog);
		if (!dialog.isConnected || dialog.dataset.state !== 'open') return;
		dialog
			.getAnimations()
			.find((animation) => animation.id === resizeId)
			?.cancel();
		if (
			skipResizeMotion() ||
			viewport?.width !== viewportWidth ||
			viewport?.height !== viewportHeight
		) return;

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
		// A rotation or software keyboard invalidates the measured destination.
		const cancel = () => resize.cancel();
		viewport?.addEventListener('resize', cancel, { once: true });
		const release = () => viewport?.removeEventListener('resize', cancel);
		void resize.finished.then(release, release);
	});
}

export function resizeDialogOnClick(event: MouseEvent): void {
	if (event.currentTarget instanceof Element) {
		animateDialogResize(event.currentTarget.closest<HTMLElement>('[data-slot="dialog-content"]'));
	}
}
