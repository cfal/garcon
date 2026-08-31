// The panel renders an absolutely positioned status cap above the detached
// composer, which overlays the cap's bottom edge. Because the cap is out of
// flow, the element above the composer must reserve vertical space or the cap
// overlaps it. When inputs are queued that element is the queue panel;
// otherwise it is the message feed. Reserving space in exactly the right place
// keeps the queue's dispatch controls visible and clickable while a cap is shown.

export interface ComposerCapReservation {
	feed: boolean;
	queue: boolean;
}

export interface ComposerCapSlotState {
	hasProjectPath: boolean;
	isProcessing: boolean;
}

// Keeps the out-of-flow cap slot stable for project chats even when no tray is
// visible. This prevents the feed from shifting when the processing tray exits.
export function shouldReserveComposerCapSlot({
	hasProjectPath,
	isProcessing,
}: ComposerCapSlotState): boolean {
	return hasProjectPath || isProcessing;
}

// Decides which element reserves space for the composer cap. At most one slot is
// active: the queue panel when queued inputs are visible, otherwise the feed.
export function composerCapReservation(
	capVisible: boolean,
	queueVisible: boolean,
): ComposerCapReservation {
	if (!capVisible) return { feed: false, queue: false };
	return { feed: !queueVisible, queue: queueVisible };
}
