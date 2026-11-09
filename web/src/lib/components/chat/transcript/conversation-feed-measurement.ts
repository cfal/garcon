import type { ConversationLayoutWaitResult, ConversationViewportFillResult } from '$lib/chat/transcript/conversation-viewport-port.js';
import type { VirtualListController } from '$lib/virt/virtual-list-controller.svelte.js';
import type { ConversationVirtualGeometrySnapshot } from './ConversationFeedProjectionState.svelte.js';
import { measureConversationViewportFill, readConversationViewportFill, nextConversationLayoutFrame, type ConversationVirtualAnchor } from './conversation-feed-virtual-runtime.js';

const MAX_SETTLE_ITERATIONS = 8;
const OFFSET_TOLERANCE_PX = 0.5;

interface ConversationFeedMeasurementOptions {
	geometry(): ConversationVirtualGeometrySnapshot;
	viewport(): HTMLDivElement | null;
	visible(): boolean;
	pinned(): boolean;
	isReady(): boolean;
	layoutToken(): number;
	appliedDataRevision(): number;
	captureReadingAnchor(): ConversationVirtualAnchor | null;
	restoreReadingAnchor(anchor: ConversationVirtualAnchor): boolean;
	scrollToEnd(): void;
}

export class ConversationFeedMeasurement {
	#measurementWake: { fingerprint: string; callback: () => void } | null = null;
	#destroyed = false;

	constructor(
		private readonly virtualList: Pick<VirtualListController, 'viewportPosition' | 'snapshot' | 'measuredSize' | 'scrollToIndex'>,
		private readonly options: ConversationFeedMeasurementOptions,
	) {}

	notifyTransaction(): void {
		if (this.#measurementWake) queueMicrotask(() => this.#notifyMeasurementWake());
	}

	destroy(): void {
		this.#destroyed = true;
		this.#measurementWake = null;
	}

	async waitForLayout(
		options: { minimumDataRevision?: number } = {},
	): Promise<ConversationLayoutWaitResult> {
		if (!this.options.isReady()) return 'not-ready';
		const token = this.options.layoutToken();
		let previous: { offset: number; revision: number } | null = null;
		for (let attempt = 0; attempt < MAX_SETTLE_ITERATIONS; attempt += 1) {
			await nextConversationLayoutFrame();
			if (token !== this.options.layoutToken()) return 'superseded';
			const position = this.virtualList.viewportPosition;
			if (!position || !this.options.visible()) return 'not-ready';
			const revision = this.virtualList.snapshot.revision;
			const dataReady =
				options.minimumDataRevision === undefined ||
				this.options.appliedDataRevision() >= options.minimumDataRevision;
			const stable =
				previous !== null &&
				previous.revision === revision &&
				Math.abs(previous.offset - position.logicalOffset) <= OFFSET_TOLERANCE_PX;
			if (dataReady && stable) return 'settled';
			previous = { offset: position.logicalOffset, revision };
		}
		return 'not-ready';
	}

	async measureViewportFill(): Promise<ConversationViewportFillResult> {
		if (!this.options.isReady()) return 'unsettled';
		const keys = this.options.geometry().keys;
		if (keys.length === 0) return 'underfilled';
		const restoreEnd = this.options.pinned();
		const readingAnchor = restoreEnd ? null : this.options.captureReadingAnchor();
		const token = this.options.layoutToken();
		return measureConversationViewportFill({
			keys,
			measuredSize: (key) => this.virtualList.measuredSize(key),
			viewport: () => this.options.viewport(),
			isCurrent: () => token === this.options.layoutToken() && this.options.isReady(),
			restoreEnd,
			readingAnchor,
			restoreReadingAnchor: (anchor) => this.options.restoreReadingAnchor(anchor),
			scrollToIndex: (index) => {
				this.virtualList.scrollToIndex(index, { align: 'start' });
			},
			scrollToEnd: () => {
				this.options.scrollToEnd();
			},
		});
	}

	readViewportFill(): ConversationViewportFillResult {
		if (!this.options.isReady()) return 'unsettled';
		return readConversationViewportFill({
			keys: this.options.geometry().keys,
			estimates: this.options.geometry().estimates,
			measuredSize: key => this.virtualList.measuredSize(key),
			viewportHeight: this.options.viewport()?.clientHeight ?? 0,
		});
	}

	onNextMeasurement(callback: () => void): () => void {
		const wake = { fingerprint: this.#measurementFingerprint(), callback };
		this.#measurementWake = wake;
		return () => {
			if (this.#measurementWake === wake) this.#measurementWake = null;
		};
	}

	#measurementFingerprint(): string {
		let measuredCount = 0;
		let measuredHeight = 0;
		for (const key of this.options.geometry().keys) {
			const size = this.virtualList.measuredSize(key);
			if (size !== undefined) {
				measuredCount += 1;
				measuredHeight += size;
			}
		}
		return [
			this.options.isReady(),
			this.options.viewport()?.clientWidth,
			this.options.viewport()?.clientHeight,
			measuredCount,
			measuredHeight,
		].join(':');
	}

	#notifyMeasurementWake(): void {
		const wake = this.#measurementWake;
		if (!wake || this.#destroyed || wake.fingerprint === this.#measurementFingerprint()) return;
		this.#measurementWake = null;
		wake.callback();
	}
}
