const REPEAT_GUARD_MS = 400;
const MOUSE_SLOP_PX = 5;
const TOUCH_SLOP_PX = 32;

interface PointerOrigin {
	x: number;
	y: number;
	radius: number;
}

function consume(event: Event): void {
	event.preventDefault();
	event.stopPropagation();
}

export class AnsiStartupInteractionState {
	#activeTouches = $state<number[]>([]);
	#repeatGuardOrigin = $state<PointerOrigin>();

	constructor(private readonly dismiss: () => void) {
		$effect(() => {
			if (!this.#repeatGuardOrigin) return;
			return this.#guardRepeat(this.#repeatGuardOrigin);
		});
	}

	get hasActiveTouches(): boolean {
		return this.#activeTouches.length > 0;
	}

	attach(target: HTMLElement): () => void {
		const preserveFocus = (event: MouseEvent) => event.preventDefault();
		const dismissFromInteraction = (event: Event) => {
			consume(event);
			if (event.type === 'click' && event instanceof MouseEvent) {
				this.#repeatGuardOrigin = { x: event.clientX, y: event.clientY, radius: MOUSE_SLOP_PX };
			}
			this.dismiss();
		};
		const beginTouch = (event: TouchEvent) => {
			consume(event);
			const active = new Set(this.#activeTouches);
			for (const touch of Array.from(event.changedTouches)) active.add(touch.identifier);
			this.#activeTouches = [...active];
		};
		const finishTouch = (event: TouchEvent) => {
			consume(event);
			const finished = Array.from(event.changedTouches, (touch) => touch.identifier);
			this.#activeTouches = this.#activeTouches.filter((id) => !finished.includes(id));
			if (this.hasActiveTouches) return;
			const point = event.changedTouches[event.changedTouches.length - 1];
			if (point) {
				this.#repeatGuardOrigin = { x: point.clientX, y: point.clientY, radius: TOUCH_SLOP_PX };
			}
			this.dismiss();
		};
		// Stops outside-interaction handlers on dialogs obscured by the intro.
		target.addEventListener('pointerdown', consume);
		target.addEventListener('mousedown', preserveFocus);
		target.addEventListener('click', dismissFromInteraction);
		target.addEventListener('wheel', dismissFromInteraction, { passive: false });
		// The overlay owns the whole gesture, including the touch pointerup before touchend.
		target.addEventListener('touchstart', beginTouch, { passive: false });
		target.addEventListener('touchend', finishTouch, { passive: false });
		target.addEventListener('touchcancel', finishTouch, { passive: false });
		return () => {
			target.removeEventListener('pointerdown', consume);
			target.removeEventListener('mousedown', preserveFocus);
			target.removeEventListener('click', dismissFromInteraction);
			target.removeEventListener('wheel', dismissFromInteraction);
			target.removeEventListener('touchstart', beginTouch);
			target.removeEventListener('touchend', finishTouch);
			target.removeEventListener('touchcancel', finishTouch);
		};
	}

	#guardRepeat(origin: PointerOrigin): () => void {
		const heldPointers = new Set<number>();
		const releasedPointers = new Set<number>();
		let timeout: number;
		const armExpiry = () => {
			window.clearTimeout(timeout);
			timeout = window.setTimeout(() => {
				this.#repeatGuardOrigin = undefined;
			}, REPEAT_GUARD_MS);
		};
		const nearOrigin = (x: number, y: number, radius: number) =>
			Math.abs(x - origin.x) <= radius && Math.abs(y - origin.y) <= radius;
		// The second click belongs to the dismissed intro, not the newly exposed workspace.
		const consumeRepeat = (event: MouseEvent) => {
			const pointer = event instanceof PointerEvent ? event : undefined;
			let radius = origin.radius;
			if (pointer) {
				radius = pointer.pointerType === 'mouse' ? MOUSE_SLOP_PX : TOUCH_SLOP_PX;
			} else if (event.type === 'mousedown') {
				radius = MOUSE_SLOP_PX;
			}
			if (pointer && event.type === 'pointerdown') {
				releasedPointers.delete(pointer.pointerId);
				if (!nearOrigin(event.clientX, event.clientY, radius)) return;
				heldPointers.add(pointer.pointerId);
				window.clearTimeout(timeout);
			} else if (pointer && (event.type === 'pointerup' || event.type === 'pointercancel')) {
				if (!heldPointers.delete(pointer.pointerId)) return;
				if (event.type === 'pointerup') {
					releasedPointers.add(pointer.pointerId);
					origin = { x: event.clientX, y: event.clientY, radius };
				} else {
					releasedPointers.delete(pointer.pointerId);
				}
				if (heldPointers.size === 0) armExpiry();
			} else {
				let ownedClick = false;
				if (event.type === 'click') {
					if (pointer) {
						ownedClick = releasedPointers.delete(pointer.pointerId);
					} else if (
						releasedPointers.size > 0 &&
						nearOrigin(event.clientX, event.clientY, radius)
					) {
						releasedPointers.clear();
						ownedClick = true;
					}
				}
				if (!ownedClick) {
					if (event.type !== 'mousedown' && event.detail < 2) return;
					if (!nearOrigin(event.clientX, event.clientY, radius)) return;
				}
			}
			consume(event);
		};
		const consumeRepeatTouch = (event: TouchEvent) => {
			const point = event.changedTouches[0];
			if (!point || !nearOrigin(point.clientX, point.clientY, TOUCH_SLOP_PX)) return;
			consume(event);
		};
		window.addEventListener('pointerdown', consumeRepeat, true);
		window.addEventListener('pointerup', consumeRepeat, true);
		window.addEventListener('pointercancel', consumeRepeat, true);
		window.addEventListener('mousedown', consumeRepeat, true);
		window.addEventListener('click', consumeRepeat, true);
		window.addEventListener('dblclick', consumeRepeat, true);
		window.addEventListener('touchstart', consumeRepeatTouch, { capture: true, passive: false });
		armExpiry();
		return () => {
			window.clearTimeout(timeout);
			window.removeEventListener('pointerdown', consumeRepeat, true);
			window.removeEventListener('pointerup', consumeRepeat, true);
			window.removeEventListener('pointercancel', consumeRepeat, true);
			window.removeEventListener('mousedown', consumeRepeat, true);
			window.removeEventListener('click', consumeRepeat, true);
			window.removeEventListener('dblclick', consumeRepeat, true);
			window.removeEventListener('touchstart', consumeRepeatTouch, true);
		};
	}
}
