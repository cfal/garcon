export const OVERLAY_BACKDROP_EFFECTS_ATTRIBUTE = 'data-overlay-backdrop-effects';
export const OVERLAY_BACKDROP_EFFECTS_ENABLED = 'enabled';
export const OVERLAY_BACKDROP_EFFECTS_DISABLED = 'disabled';

export function projectOverlayBackdropEffects(root: HTMLElement, enabled: boolean): () => void {
	root.setAttribute(
		OVERLAY_BACKDROP_EFFECTS_ATTRIBUTE,
		enabled ? OVERLAY_BACKDROP_EFFECTS_ENABLED : OVERLAY_BACKDROP_EFFECTS_DISABLED,
	);

	return () => {
		root.removeAttribute(OVERLAY_BACKDROP_EFFECTS_ATTRIBUTE);
	};
}
