import type { Attachment } from 'svelte/attachments';

// Moves the attached overlay element to the end of document.body so its
// fixed positioning escapes ancestor transforms and stacking contexts.
// The mobile drawer sits inside .mobile-shell, which always carries a
// translateY transform and therefore becomes the containing block for
// every fixed descendant, confining overlays to the drawer.
export const bodyPortal: Attachment<HTMLElement> = (node) => {
	document.body.appendChild(node);
	return () => {
		node.remove();
	};
};
