import type { ConversationSettingsController } from './conversation-settings-controller.svelte.js';
import type { ConversationQueueController } from './conversation-queue-controller.svelte.js';

export interface DirectAdmissionBarrier {
	readonly settled: Promise<void>;
	release(): void;
}

export class ConversationAdmissionController {
	#pending = $state.raw<ReadonlyMap<string, DirectAdmissionBarrier>>(new Map());

	constructor(
		private readonly settings: Pick<ConversationSettingsController, 'hasPending' | 'settlePending'>,
		private readonly queue: Pick<ConversationQueueController, 'pendingControlRefresh' | 'settleControlRefresh'>,
	) {}

	isPending(chatId: string | null): boolean {
		return chatId !== null && this.#pending.has(chatId);
	}

	wait(chatId: string): Promise<void> | undefined {
		return this.#pending.get(chatId)?.settled;
	}

	claim(chatId: string): DirectAdmissionBarrier | null {
		if (this.#pending.has(chatId)) return null;
		let release!: () => void;
		const settled = new Promise<void>((resolve) => { release = resolve; });
		const barrier = { settled, release };
		this.#pending = new Map(this.#pending).set(chatId, barrier);
		return barrier;
	}

	release(chatId: string, barrier: DirectAdmissionBarrier): void {
		if (this.#pending.get(chatId) !== barrier) return;
		const next = new Map(this.#pending);
		next.delete(chatId);
		this.#pending = next;
		barrier.release();
	}

	settleSettings(chatId: string): Promise<boolean> | undefined {
		return this.settings.hasPending(chatId) ? this.settings.settlePending(chatId) : undefined;
	}

	settleQueueControl(chatId: string): Promise<void> | undefined {
		const refresh = this.queue.pendingControlRefresh(chatId);
		return refresh ? this.queue.settleControlRefresh(refresh) : undefined;
	}
}
