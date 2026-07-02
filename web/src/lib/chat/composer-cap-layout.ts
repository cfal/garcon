// The composer renders an absolutely positioned cap directly above itself: the
// agent status tray while a turn is processing, or the git quick-commit tray
// otherwise. Because the cap is out of flow, it floats up over whichever element
// sits immediately above the composer, so that element must reserve vertical
// space or the cap overlaps it. When inputs are queued the queue panel is the
// element directly above the composer; otherwise the message feed is. Reserving
// space in exactly the right place keeps the queue's dispatch controls visible
// and clickable while a cap is shown.

export interface ComposerCapReservation {
	feed: boolean;
	queue: boolean;
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
