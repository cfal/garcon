// Happy DOM fires these synchronously; browsers coalesce them onto a later task.
// https://w3c.github.io/selection-api/#scheduling-selectionchange-event
export function deferDocumentSelectionChanges(): () => void {
	const original = document.dispatchEvent;
	let pending: ReturnType<typeof setTimeout> | undefined;
	document.dispatchEvent = function (event: Event): boolean {
		if (event.type !== 'selectionchange' || event.eventPhase !== Event.NONE) {
			return original.call(this, event);
		}
		pending ??= setTimeout(() => {
			pending = undefined;
			original.call(document, event);
		}, 0);
		return true;
	};
	return () => {
		clearTimeout(pending);
		document.dispatchEvent = original;
	};
}
