import type { TranscriptPageDirection } from './transcript-page-progress.js';

export interface ConversationTouchPoint {
	identifier: number;
	clientY: number;
}

export interface ConversationScrollGestureHandlers {
	onScrollIntent(direction: TranscriptPageDirection | null): void;
	onContentTouchStart(): void;
	onContentTouchEnd(): void;
	onContentTouchReset(): void;
}

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
	handlers: ConversationScrollGestureHandlers,
): () => void {
	const touchGesture = new ConversationTouchScrollGesture();
	const contentTouchIdentifiers = new Set<number>();
	const touchPoints = (touches: TouchList): ConversationTouchPoint[] =>
		Array.from(touches, (touch) => ({
			identifier: touch.identifier,
			clientY: touch.clientY,
		}));
	const contentTouchPoints = (event: TouchEvent): ConversationTouchPoint[] =>
		touchPoints(event.touches).filter((touch) => contentTouchIdentifiers.has(touch.identifier));
	const handleWheel = (event: WheelEvent) => {
		const direction = conversationWheelScrollDirection(event.deltaY);
		if (direction) handlers.onScrollIntent(direction);
	};
	const handleTouchStart = (event: TouchEvent) => {
		const wasActive = contentTouchIdentifiers.size > 0;
		for (const touch of touchPoints(event.changedTouches)) {
			contentTouchIdentifiers.add(touch.identifier);
		}
		if (!wasActive && contentTouchIdentifiers.size > 0) handlers.onContentTouchStart();
		const touches = contentTouchPoints(event);
		if (touchGesture.begin(touches)) handlers.onScrollIntent(null);
	};
	const handleTouchMove = (event: TouchEvent) => {
		const direction = touchGesture.move(contentTouchPoints(event));
		if (direction) handlers.onScrollIntent(direction);
	};
	const handleTouchEnd = (event: TouchEvent) => {
		const wasActive = contentTouchIdentifiers.size > 0;
		for (const touch of touchPoints(event.changedTouches)) {
			contentTouchIdentifiers.delete(touch.identifier);
		}
		touchGesture.end(contentTouchPoints(event));
		if (wasActive && contentTouchIdentifiers.size === 0) handlers.onContentTouchEnd();
	};
	const handlePointerDown = (event: PointerEvent) => {
		if (event.button === 0 && event.pointerType !== 'touch') handlers.onScrollIntent(null);
	};
	const handleKeydown = (event: KeyboardEvent) => {
		if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home') {
			handlers.onScrollIntent('earlier');
		} else if (event.key === ' ') {
			handlers.onScrollIntent(event.shiftKey ? 'earlier' : 'later');
		} else if (event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === 'End') {
			handlers.onScrollIntent('later');
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
		if (contentTouchIdentifiers.size > 0) handlers.onContentTouchReset();
		contentTouchIdentifiers.clear();
	};
}
