import type { ConversationNativeTouchPhase } from './conversation-scroll-gesture.js';

export const NATIVE_SCROLL_SETTLE_DELAY_MS = 200;

export type ConversationNativeScrollActivity = 'idle' | 'dragging' | 'coasting';
export type ConversationNativeScrollSettlementResult = 'settled' | 'cancelled';

export class ConversationNativeScrollSettlement {
	#activity: ConversationNativeScrollActivity = 'idle';
	#cancelEpoch = 0;
	#settleTimer: ReturnType<typeof setTimeout> | null = null;
	#settled: Promise<void> = Promise.resolve();
	#resolveSettled: (() => void) | null = null;
	#touchDown = false;
	#touchMoved = false;

	constructor(
		private readonly onActivityChange: (activity: ConversationNativeScrollActivity) => void,
	) {}

	get activity(): ConversationNativeScrollActivity {
		return this.#activity;
	}

	noteTouch(phase: ConversationNativeTouchPhase): void {
		if (phase === 'start') {
			this.#touchDown = true;
			this.#touchMoved = false;
			if (this.#activity === 'coasting') this.#clearSettleTimer();
			return;
		}
		if (phase === 'move') {
			this.#touchDown = true;
			this.#touchMoved = true;
			this.#clearSettleTimer();
			this.#setActivity('dragging');
			return;
		}

		this.#touchDown = false;
		const shouldSettle = this.#touchMoved || this.#activity !== 'idle';
		this.#touchMoved = false;
		if (!shouldSettle) return;
		this.#setActivity('coasting');
		this.#scheduleSettlement();
	}

	noteScroll(): void {
		if (this.#activity === 'coasting' && !this.#touchDown) this.#scheduleSettlement();
	}

	async waitUntilIdle(): Promise<ConversationNativeScrollSettlementResult> {
		const cancelEpoch = this.#cancelEpoch;
		while (this.#activity !== 'idle') {
			const settled = this.#settled;
			await settled;
			if (cancelEpoch !== this.#cancelEpoch) return 'cancelled';
		}
		return cancelEpoch === this.#cancelEpoch ? 'settled' : 'cancelled';
	}

	cancel(): void {
		this.#cancelEpoch += 1;
		this.#touchDown = false;
		this.#touchMoved = false;
		this.#clearSettleTimer();
		this.#setActivity('idle');
	}

	#scheduleSettlement(): void {
		this.#clearSettleTimer();
		this.#settleTimer = setTimeout(() => {
			this.#settleTimer = null;
			if (this.#touchDown || this.#activity !== 'coasting') return;
			this.#setActivity('idle');
		}, NATIVE_SCROLL_SETTLE_DELAY_MS);
	}

	#clearSettleTimer(): void {
		if (this.#settleTimer === null) return;
		clearTimeout(this.#settleTimer);
		this.#settleTimer = null;
	}

	#setActivity(activity: ConversationNativeScrollActivity): void {
		if (activity === this.#activity) return;
		const wasIdle = this.#activity === 'idle';
		this.#activity = activity;
		if (wasIdle && activity !== 'idle') {
			this.#settled = new Promise<void>((resolve) => {
				this.#resolveSettled = resolve;
			});
		}
		this.onActivityChange(activity);
		if (activity !== 'idle') return;
		const resolve = this.#resolveSettled;
		this.#resolveSettled = null;
		resolve?.();
	}
}
