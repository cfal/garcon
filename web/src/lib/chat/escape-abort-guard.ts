const ESCAPE_ABORT_BLOCKING_LAYER_SELECTOR = [
	'[data-escape-dismiss-layer]',
	'[data-dismissable-layer]',
	'[data-melt-menu]',
	'[data-slot="dialog-content"]',
	'[data-slot="popover-content"]',
	'[data-slot="dropdown-menu-content"]',
	'[data-slot="select-content"]',
	'[data-slot="context-menu-content"]',
	'[role="dialog"]',
	'[role="menu"]',
].join(', ');

export function hasEscapeOwningLayer(doc: Document = document): boolean {
	return doc.querySelector(ESCAPE_ABORT_BLOCKING_LAYER_SELECTOR) !== null;
}

export function shouldHandleGlobalEscapeAbort(
	event: KeyboardEvent,
	doc: Document = document,
): boolean {
	return (
		event.key === 'Escape' && !event.repeat && !event.defaultPrevented && !hasEscapeOwningLayer(doc)
	);
}
