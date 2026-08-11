import type { TranscriptPageDirection } from './transcript-page-progress.js';

export interface ConversationTouchPoint {
	identifier: number;
	clientY: number;
}

export type ConversationScrollIntentReporter = (direction: TranscriptPageDirection | null) => void;

export class ConversationTouchScrollGesture {
	#identifier: number | null = null;
	#clientY: number | null = null;

	begin(touches: readonly ConversationTouchPoint[]): boolean {
		if (touches.some((touch) => touch.identifier === this.#identifier)) return false;
		const touch = touches[0];
		this.#identifier = touch?.identifier ?? null;
		this.#clientY = touch?.clientY ?? null;
		return touch !== undefined;
	}

	move(touches: readonly ConversationTouchPoint[]): TranscriptPageDirection | null {
		const touch = touches.find((candidate) => candidate.identifier === this.#identifier);
		if (!touch || this.#clientY === null) {
			this.begin(touches);
			return null;
		}
		const direction = conversationTouchScrollDirection(this.#clientY, touch.clientY);
		this.#clientY = touch.clientY;
		return direction;
	}

	end(touches: readonly ConversationTouchPoint[]): void {
		const touch =
			touches.find((candidate) => candidate.identifier === this.#identifier) ?? touches[0];
		this.#identifier = touch?.identifier ?? null;
		this.#clientY = touch?.clientY ?? null;
	}
}

export function conversationTouchScrollDirection(
	previousClientY: number,
	currentClientY: number,
): TranscriptPageDirection | null {
	if (currentClientY === previousClientY) return null;
	return currentClientY > previousClientY ? 'earlier' : 'later';
}

export function conversationScrollbarScrollDirection(
	previousClientY: number,
	currentClientY: number,
): TranscriptPageDirection | null {
	if (currentClientY === previousClientY) return null;
	return currentClientY < previousClientY ? 'earlier' : 'later';
}

export function conversationScrollbarTrackDirection(
	pointerClientY: number,
	thumbTop: number,
	thumbBottom: number,
): TranscriptPageDirection | null {
	const thumbCenter = (thumbTop + thumbBottom) / 2;
	if (pointerClientY < thumbCenter) return 'earlier';
	if (pointerClientY > thumbCenter) return 'later';
	return null;
}

export function conversationWheelScrollDirection(deltaY: number): TranscriptPageDirection | null {
	if (deltaY === 0) return null;
	return deltaY < 0 ? 'earlier' : 'later';
}

export function observeConversationViewportScrollGestures(
	node: HTMLElement,
	report: ConversationScrollIntentReporter,
): () => void {
	const touchGesture = new ConversationTouchScrollGesture();
	const touchPoints = (event: TouchEvent): ConversationTouchPoint[] =>
		Array.from(event.touches, (touch) => ({
			identifier: touch.identifier,
			clientY: touch.clientY,
		}));
	const handleWheel = (event: WheelEvent) => {
		const direction = conversationWheelScrollDirection(event.deltaY);
		if (direction) report(direction);
	};
	const handleTouchStart = (event: TouchEvent) => {
		if (touchGesture.begin(touchPoints(event))) report(null);
	};
	const handleTouchMove = (event: TouchEvent) => {
		const direction = touchGesture.move(touchPoints(event));
		if (direction) report(direction);
	};
	const handleTouchEnd = (event: TouchEvent) => {
		touchGesture.end(touchPoints(event));
	};
	const handlePointerDown = (event: PointerEvent) => {
		if (event.button === 0 && event.pointerType !== 'touch') report(null);
	};
	const handleKeydown = (event: KeyboardEvent) => {
		if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home') {
			report('earlier');
		} else if (event.key === ' ') {
			report(event.shiftKey ? 'earlier' : 'later');
		} else if (event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === 'End') {
			report('later');
		}
	};

	node.addEventListener('wheel', handleWheel, { capture: true, passive: true });
	node.addEventListener('touchstart', handleTouchStart, { capture: true, passive: true });
	node.addEventListener('touchmove', handleTouchMove, { capture: true, passive: true });
	node.addEventListener('touchend', handleTouchEnd, { capture: true, passive: true });
	node.addEventListener('touchcancel', handleTouchEnd, { capture: true, passive: true });
	node.addEventListener('pointerdown', handlePointerDown, { capture: true, passive: true });
	node.addEventListener('keydown', handleKeydown, { capture: true });

	return () => {
		node.removeEventListener('wheel', handleWheel, { capture: true });
		node.removeEventListener('touchstart', handleTouchStart, { capture: true });
		node.removeEventListener('touchmove', handleTouchMove, { capture: true });
		node.removeEventListener('touchend', handleTouchEnd, { capture: true });
		node.removeEventListener('touchcancel', handleTouchEnd, { capture: true });
		node.removeEventListener('pointerdown', handlePointerDown, { capture: true });
		node.removeEventListener('keydown', handleKeydown, { capture: true });
	};
}
