import {
	measureElement as measureVirtualElement,
	observeElementOffset as observeVirtualElementOffset,
	type SvelteVirtualizer,
	type VirtualItem,
	type Virtualizer,
} from '@tanstack/svelte-virtual';
import type { ConversationNativeScrollActivity } from '$lib/chat/transcript/conversation-native-scroll-settlement.js';
import { isConversationTargetLayoutReady } from './conversation-feed-viewport-geometry.js';

export interface ConversationVirtualMeasurementPort {
	indexFromElement(element: HTMLDivElement): number;
	isScrolling: boolean;
	itemSizeCache: Map<VirtualItem['key'], number>;
	measure(): void;
	measureElement(element: HTMLDivElement | null): void;
	options: Pick<
		SvelteVirtualizer<HTMLElement, HTMLDivElement>['options'],
		'count' | 'estimateSize' | 'getItemKey'
	>;
	resizeItem(index: number, size: number): void;
	scrollDirection: 'forward' | 'backward' | null;
}

export function measureConversationVirtualItem(
	element: HTMLDivElement,
	entry: ResizeObserverEntry | undefined,
	instance: Virtualizer<HTMLElement, HTMLDivElement>,
): number {
	const index = instance.indexFromElement(element);
	const key = instance.options.getItemKey(index);
	if (!isConversationTargetLayoutReady(element)) {
		return instance.itemSizeCache.get(key) ?? instance.options.estimateSize(index);
	}
	return measureVirtualElement(element, entry, instance);
}

export function observeConversationItemLayoutSettlement(
	element: HTMLDivElement,
	onSettled: () => void,
): () => void {
	let layoutReady = isConversationTargetLayoutReady(element);
	const update = () => {
		const nextLayoutReady = isConversationTargetLayoutReady(element);
		if (!layoutReady && nextLayoutReady) onSettled();
		layoutReady = nextLayoutReady;
	};
	const MutationObserverConstructor = element.ownerDocument.defaultView?.MutationObserver;
	const observer = MutationObserverConstructor ? new MutationObserverConstructor(update) : null;
	observer?.observe(element, {
		attributeFilter: ['data-chat-layout-pending', 'src', 'srcset'],
		attributes: true,
		childList: true,
		subtree: true,
	});
	element.addEventListener('load', update, true);
	element.addEventListener('error', update, true);
	return () => {
		observer?.disconnect();
		element.removeEventListener('load', update, true);
		element.removeEventListener('error', update, true);
	};
}

export function settleConversationVirtualItemMeasurement(
	element: HTMLDivElement,
	instance: ConversationVirtualMeasurementPort,
): void {
	if (!element.isConnected || !isConversationTargetLayoutReady(element)) return;
	const index = instance.indexFromElement(element);
	if (index < 0 || index >= instance.options.count) return;
	if (String(instance.options.getItemKey(index)) !== element.dataset.chatVirtualItem) return;
	instance.resizeItem(index, element.offsetHeight);
}

interface ConversationDeferredVirtualRemount {
	element: HTMLDivElement;
	key: VirtualItem['key'];
}

interface ConversationPendingFirstMeasurement extends ConversationDeferredVirtualRemount {
	instance: ConversationVirtualMeasurementPort;
}

interface ConversationResolvedFirstMeasurement extends ConversationPendingFirstMeasurement {
	size: number;
}

// Holds exact cached geometry through backward user motion and measures unseen rows before paint.
export class ConversationVirtualMeasurementManager {
	#deferredRemounts = new Map<VirtualItem['key'], ConversationDeferredVirtualRemount>();
	#pendingFirstMeasurements = new Map<
		VirtualItem['key'],
		ConversationPendingFirstMeasurement
	>();
	#firstMeasurementScheduled = false;
	#scrollDirection: 'forward' | 'backward' | null = null;

	constructor(
		private readonly nativeActivity: () => ConversationNativeScrollActivity,
		private readonly ownsScrollPosition: () => boolean,
	) {}

	measureElement = (
		element: HTMLDivElement,
		entry: ResizeObserverEntry | undefined,
		instance: Virtualizer<HTMLElement, HTMLDivElement>,
	): number => {
		const measurement = measureConversationVirtualItem(element, entry, instance);
		const identity = this.#identity(element, instance);
		if (!identity) return measurement;
		const deferred = this.#deferredRemounts.get(identity.key);
		const cached = instance.itemSizeCache.get(identity.key);
		if (deferred?.element === element && cached !== undefined) {
			const layoutReady = isConversationTargetLayoutReady(element);
			if (!layoutReady) return cached;
			if (this.#shouldDefer(instance)) {
				if (measurement === cached) {
					this.#deferredRemounts.delete(identity.key);
					return measurement;
				}
				return cached;
			}
			this.#deferredRemounts.delete(identity.key);
		}
		return measurement;
	};

	observeElementOffset = (
		instance: Virtualizer<HTMLElement, HTMLDivElement>,
		callback: (offset: number, isScrolling: boolean) => void,
	): (() => void) | undefined =>
		observeVirtualElementOffset(instance, (offset, isScrolling) => {
			callback(offset, isScrolling);
			if (instance.scrollDirection !== null) this.#scrollDirection = instance.scrollDirection;
			if (isScrolling || this.nativeActivity() !== 'idle') return;
			this.#scrollDirection = null;
			this.flush(instance);
		});

	attach(element: HTMLDivElement, instance: ConversationVirtualMeasurementPort): () => void {
		const identity = this.#identity(element, instance);
		if (identity && instance.itemSizeCache.has(identity.key) && this.#shouldDefer(instance)) {
			this.#deferredRemounts.set(identity.key, { element, key: identity.key });
		}
		const stopObservingLayout = observeConversationItemLayoutSettlement(element, () =>
			this.#settle(element, instance),
		);
		instance.measureElement(element);
		if (identity && instance.isScrolling && !instance.itemSizeCache.has(identity.key)) {
			this.#queueFirstMeasurement({ element, instance, key: identity.key });
		}
		return () => {
			stopObservingLayout();
			this.#deletePendingFirstMeasurement(element, identity?.key);
			if (identity && this.#deferredRemounts.get(identity.key)?.element === element) {
				this.#deferredRemounts.delete(identity.key);
			}
			instance.measureElement(null);
		};
	}

	flush(instance: ConversationVirtualMeasurementPort): void {
		this.#flushFirstMeasurements();
		if (instance.isScrolling || this.nativeActivity() !== 'idle' || this.ownsScrollPosition()) {
			return;
		}
		const deferred = [...this.#deferredRemounts.values()];
		this.#deferredRemounts.clear();
		for (const remount of deferred) {
			const identity = this.#identity(remount.element, instance);
			if (
				!identity ||
				identity.key !== remount.key ||
				!isConversationTargetLayoutReady(remount.element)
			) {
				continue;
			}
			instance.resizeItem(identity.index, remount.element.offsetHeight);
		}
	}

	settleNativeScroll(instance: ConversationVirtualMeasurementPort): void {
		this.#scrollDirection = null;
		this.flush(instance);
	}

	takeProgrammaticOwnership(instance: ConversationVirtualMeasurementPort): void {
		this.#scrollDirection = null;
		this.#flushFirstMeasurements();
		for (const remount of [...this.#deferredRemounts.values()]) {
			const identity = this.#identity(remount.element, instance);
			if (!identity || identity.key !== remount.key) {
				this.#deferredRemounts.delete(remount.key);
				continue;
			}
			if (!isConversationTargetLayoutReady(remount.element)) continue;
			this.#deferredRemounts.delete(remount.key);
			instance.resizeItem(identity.index, remount.element.offsetHeight);
		}
	}

	reset(instance: ConversationVirtualMeasurementPort): void {
		this.clear();
		instance.measure();
	}

	clear(): void {
		this.#deferredRemounts.clear();
		this.#pendingFirstMeasurements.clear();
		this.#scrollDirection = null;
	}

	#queueFirstMeasurement(pending: ConversationPendingFirstMeasurement): void {
		this.#pendingFirstMeasurements.set(pending.key, pending);
		if (this.#firstMeasurementScheduled) return;
		this.#firstMeasurementScheduled = true;
		queueMicrotask(() => {
			this.#firstMeasurementScheduled = false;
			this.#flushFirstMeasurements();
		});
	}

	#flushFirstMeasurements(): void {
		const pending = [...this.#pendingFirstMeasurements.values()];
		this.#pendingFirstMeasurements.clear();
		const measured: ConversationResolvedFirstMeasurement[] = [];
		for (const candidate of pending) {
			const identity = this.#identity(candidate.element, candidate.instance);
			if (
				!identity ||
				identity.key !== candidate.key ||
				candidate.instance.itemSizeCache.has(candidate.key) ||
				!isConversationTargetLayoutReady(candidate.element)
			) {
				continue;
			}
			measured.push({ ...candidate, size: candidate.element.offsetHeight });
		}
		for (const item of measured) {
			const identity = this.#identity(item.element, item.instance);
			if (!identity || identity.key !== item.key || item.instance.itemSizeCache.has(item.key)) {
				continue;
			}
			item.instance.resizeItem(identity.index, item.size);
		}
	}

	#deletePendingFirstMeasurement(
		element: HTMLDivElement,
		key: VirtualItem['key'] | undefined,
	): void {
		if (key !== undefined && this.#pendingFirstMeasurements.get(key)?.element === element) {
			this.#pendingFirstMeasurements.delete(key);
		}
	}

	#settle(element: HTMLDivElement, instance: ConversationVirtualMeasurementPort): void {
		const identity = this.#identity(element, instance);
		this.#deletePendingFirstMeasurement(element, identity?.key);
		if (
			identity &&
			this.#deferredRemounts.get(identity.key)?.element === element &&
			this.#shouldDefer(instance)
		) {
			return;
		}
		if (identity) this.#deferredRemounts.delete(identity.key);
		settleConversationVirtualItemMeasurement(element, instance);
	}

	#shouldDefer(instance: ConversationVirtualMeasurementPort): boolean {
		return (
			!this.ownsScrollPosition() &&
			(instance.isScrolling || this.nativeActivity() !== 'idle') &&
			(instance.scrollDirection ?? this.#scrollDirection) === 'backward'
		);
	}

	#identity(
		element: HTMLDivElement,
		instance: ConversationVirtualMeasurementPort,
	): { index: number; key: VirtualItem['key'] } | null {
		if (!element.isConnected) return null;
		const index = instance.indexFromElement(element);
		if (index < 0 || index >= instance.options.count) return null;
		const key = instance.options.getItemKey(index);
		return String(key) === element.dataset.chatVirtualItem ? { index, key } : null;
	}
}
