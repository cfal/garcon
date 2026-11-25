import type { SidebarChatDragData } from './sidebar-pragmatic-dnd';

interface SidebarTouchReorderOptions {
	resolveSource(target: EventTarget | null): SidebarChatDragData | null;
	canActivate(): boolean;
	viewport(): HTMLElement | null;
	scrollBy(delta: number): void;
	onActivate(source: SidebarChatDragData): void;
	onMove(source: SidebarChatDragData, x: number, y: number): void;
	onFinish(source: SidebarChatDragData, x: number, y: number): void;
	onCancel(source: SidebarChatDragData): void;
}

interface TouchDrag {
	source: SidebarChatDragData;
	target: Element;
	identifier: number;
	startX: number;
	startY: number;
	x: number;
	y: number;
	timer: ReturnType<typeof setTimeout>;
	active: boolean;
}

const LONG_PRESS_MS = 360;
const MOVE_THRESHOLD = 10;
const AUTO_SCROLL_EDGE = 56;
const AUTO_SCROLL_MAX = 18;
const SELECTION_PROPERTIES = ['user-select', '-webkit-user-select', '-webkit-touch-callout'];

function guardSelection(): () => void {
	const restore = [document.body, document.documentElement].flatMap(({ style }) =>
		SELECTION_PROPERTIES.map((property) => {
			const value = style.getPropertyValue(property);
			const priority = style.getPropertyPriority(property);
			style.setProperty(property, 'none');
			return () => {
				if (value) style.setProperty(property, value, priority);
				else style.removeProperty(property);
			};
		}),
	);
	return () => {
		for (const reset of restore) reset();
	};
}

export class SidebarTouchReorderController {
	#drag: TouchDrag | null = null;
	#frame: number | null = null;
	#restoreSelection: (() => void) | undefined;
	#suppressClickUntil = 0;

	constructor(private readonly options: SidebarTouchReorderOptions) {}

	attach = (element: HTMLElement): (() => void) => {
		element.addEventListener('touchstart', this.#start, { passive: true });
		element.addEventListener('click', this.#click, true);
		return () => {
			element.removeEventListener('touchstart', this.#start);
			element.removeEventListener('click', this.#click, true);
			this.cancel();
		};
	};

	cancel(): void {
		const drag = this.#drag;
		this.#clear();
		if (drag?.active) this.options.onCancel(drag.source);
	}

	sourceUnmounted(chatId: string): void {
		if (this.#drag?.source.chatId === chatId && !this.#drag.active) this.cancel();
	}

	#clear(): void {
		if (this.#drag) clearTimeout(this.#drag.timer);
		this.#drag = null;
		if (this.#frame !== null) cancelAnimationFrame(this.#frame);
		this.#frame = null;
		window.removeEventListener('touchmove', this.#move);
		window.removeEventListener('touchend', this.#end);
		window.removeEventListener('touchcancel', this.#cancelTouch);
		window.removeEventListener('contextmenu', this.#contextMenu, true);
		this.#restoreSelection?.();
		this.#restoreSelection = undefined;
	}

	#start = (event: TouchEvent): void => {
		if (event.touches.length !== 1) {
			this.cancel();
			return;
		}
		if (!this.options.canActivate()) return;
		const source = this.options.resolveSource(event.target);
		const touch = event.changedTouches[0];
		if (!(event.target instanceof Element) || !source || !touch) return;
		this.#clear();
		this.#restoreSelection = guardSelection();
		this.#drag = {
			source,
			target: event.target,
			identifier: touch.identifier,
			startX: touch.clientX,
			startY: touch.clientY,
			x: touch.clientX,
			y: touch.clientY,
			active: false,
			timer: setTimeout(this.#activate, LONG_PRESS_MS),
		};
		window.addEventListener('touchmove', this.#move, { passive: true });
		window.addEventListener('touchend', this.#end, { passive: false });
		window.addEventListener('touchcancel', this.#cancelTouch, { passive: true });
		window.addEventListener('contextmenu', this.#contextMenu, true);
	};

	#activate = (): void => {
		const drag = this.#drag;
		if (!drag) return;
		if (!drag.target.isConnected || !this.options.canActivate()) {
			this.#clear();
			return;
		}
		drag.active = true;
		window.removeEventListener('touchmove', this.#move);
		window.addEventListener('touchmove', this.#move, { passive: false });
		window.getSelection()?.removeAllRanges();
		this.options.onActivate(drag.source);
		this.options.onMove(drag.source, drag.x, drag.y);
		this.#scheduleAutoScroll();
	};

	#touchFor(event: TouchEvent, drag: TouchDrag): Touch | undefined {
		for (const touch of event.changedTouches) {
			if (touch.identifier === drag.identifier) return touch;
		}
	}

	#move = (event: TouchEvent): void => {
		const drag = this.#drag;
		const touch = drag && this.#touchFor(event, drag);
		if (!drag || !touch) return;
		drag.x = touch.clientX;
		drag.y = touch.clientY;
		if (!drag.active) {
			if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) > MOVE_THRESHOLD) this.cancel();
			return;
		}
		event.preventDefault();
		window.getSelection()?.removeAllRanges();
		this.options.onMove(drag.source, drag.x, drag.y);
		this.#scheduleAutoScroll();
	};

	#end = (event: TouchEvent): void => {
		const drag = this.#drag;
		const touch = drag && this.#touchFor(event, drag);
		if (!drag || !touch) return;
		this.#clear();
		if (!drag.active) return;
		event.preventDefault();
		window.getSelection()?.removeAllRanges();
		this.#suppressClickUntil = performance.now() + 500;
		this.options.onFinish(drag.source, touch.clientX, touch.clientY);
	};

	#cancelTouch = (event: TouchEvent): void => {
		if (this.#drag && (!event.changedTouches?.length || this.#touchFor(event, this.#drag))) this.cancel();
	};

	#contextMenu = (event: Event): void => {
		if (this.#drag?.active || performance.now() < this.#suppressClickUntil) event.preventDefault();
	};

	#click = (event: MouseEvent): void => {
		if (performance.now() >= this.#suppressClickUntil) return;
		event.preventDefault();
		event.stopPropagation();
	};

	#scheduleAutoScroll(): void {
		this.#frame ??= requestAnimationFrame(this.#autoScroll);
	}

	#autoScroll = (): void => {
		this.#frame = null;
		const drag = this.#drag;
		const viewport = this.options.viewport();
		if (!drag?.active || !viewport) return;
		const { top, bottom } = viewport.getBoundingClientRect();
		let delta = 0;
		if (drag.y < top + AUTO_SCROLL_EDGE)
			delta = -Math.ceil(Math.min(AUTO_SCROLL_MAX, (top + AUTO_SCROLL_EDGE - drag.y) / 3));
		else if (drag.y > bottom - AUTO_SCROLL_EDGE)
			delta = Math.ceil(Math.min(AUTO_SCROLL_MAX, (drag.y - bottom + AUTO_SCROLL_EDGE) / 3));
		if (!delta) return;
		this.options.scrollBy(delta);
		this.options.onMove(drag.source, drag.x, drag.y);
		this.#scheduleAutoScroll();
	};
}
