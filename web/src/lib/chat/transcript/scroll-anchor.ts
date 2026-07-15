// Applies queue panel height deltas to the message scroller without
// changing the user-visible anchor point.
export function reconcileScrollAfterHeightDelta(
	delta: number,
	isPinnedToBottom: boolean,
	scrollContainer: { scrollTop: number },
	pinToBottom: () => void,
): void {
	if (!delta) return;
	if (isPinnedToBottom) {
		pinToBottom();
		return;
	}
	scrollContainer.scrollTop += delta;
}
