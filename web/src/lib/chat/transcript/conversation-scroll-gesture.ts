import type { TranscriptPageDirection } from './transcript-page-progress.js';

export interface ConversationTouchPoint {
	identifier: number;
	clientY: number;
}

export type ConversationNativeTouchPhase = 'start' | 'move' | 'end';
export type ConversationScrollContactPhase = 'start' | 'end';

export interface ConversationScrollIntent {
	direction: TranscriptPageDirection | null;
	// Carries the native touch lifetime; a directionless start stays stateless for settlement.
	touch: ConversationNativeTouchPhase | null;
	contact: ConversationScrollContactPhase | null;
}

export type ConversationScrollIntentReporter = (intent: ConversationScrollIntent) => void;

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
	let pointerId: number | null = null;
	const touchPoints = (event: TouchEvent): ConversationTouchPoint[] =>
		Array.from(event.touches, (touch) => ({
			identifier: touch.identifier,
			clientY: touch.clientY,
		}));
	const handleWheel = (event: WheelEvent) => {
		const direction = conversationWheelScrollDirection(event.deltaY);
		if (direction) report({ direction, touch: null, contact: null });
	};
	const handleTouchStart = (event: TouchEvent) => {
		if (touchGesture.begin(touchPoints(event))) {
			report({ direction: null, touch: 'start', contact: 'start' });
		}
	};
	const handleTouchMove = (event: TouchEvent) => {
		const direction = touchGesture.move(touchPoints(event));
		if (direction) report({ direction, touch: 'move', contact: null });
	};
	const handleTouchEnd = (event: TouchEvent) => {
		touchGesture.end(touchPoints(event));
		// Ownership ends only when the last finger lifts; a partial lift keeps the gesture alive.
		if (event.touches.length === 0) {
			report({ direction: null, touch: 'end', contact: 'end' });
		}
	};
	const handlePointerDown = (event: PointerEvent) => {
		if (event.button !== 0 || event.pointerType === 'touch') return;
		pointerId = event.pointerId;
		report({ direction: null, touch: null, contact: 'start' });
	};
	const handlePointerEnd = (event: PointerEvent) => {
		if (event.pointerId !== pointerId) return;
		pointerId = null;
		report({ direction: null, touch: null, contact: 'end' });
	};
	const handleKeydown = (event: KeyboardEvent) => {
		if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home') {
			report({ direction: 'earlier', touch: null, contact: null });
		} else if (event.key === ' ') {
			report({
				direction: event.shiftKey ? 'earlier' : 'later',
				touch: null,
				contact: null,
			});
		} else if (event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === 'End') {
			report({ direction: 'later', touch: null, contact: null });
		}
	};

	node.addEventListener('wheel', handleWheel, { capture: true, passive: true });
	node.addEventListener('touchstart', handleTouchStart, { capture: true, passive: true });
	node.addEventListener('touchmove', handleTouchMove, { capture: true, passive: true });
	node.addEventListener('touchend', handleTouchEnd, { capture: true, passive: true });
	node.addEventListener('touchcancel', handleTouchEnd, { capture: true, passive: true });
	node.addEventListener('pointerdown', handlePointerDown, { capture: true, passive: true });
	node.addEventListener('pointerup', handlePointerEnd, { capture: true, passive: true });
	node.addEventListener('pointercancel', handlePointerEnd, { capture: true, passive: true });
	node.addEventListener('keydown', handleKeydown, { capture: true });

	return () => {
		node.removeEventListener('wheel', handleWheel, { capture: true });
		node.removeEventListener('touchstart', handleTouchStart, { capture: true });
		node.removeEventListener('touchmove', handleTouchMove, { capture: true });
		node.removeEventListener('touchend', handleTouchEnd, { capture: true });
		node.removeEventListener('touchcancel', handleTouchEnd, { capture: true });
		node.removeEventListener('pointerdown', handlePointerDown, { capture: true });
		node.removeEventListener('pointerup', handlePointerEnd, { capture: true });
		node.removeEventListener('pointercancel', handlePointerEnd, { capture: true });
		node.removeEventListener('keydown', handleKeydown, { capture: true });
	};
}
