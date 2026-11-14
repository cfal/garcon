import { SvelteMap } from 'svelte/reactivity';
import { CommandOutcomeUnknownError } from './idempotent-command.js';
import * as m from '$lib/paraglide/messages.js';

const MAX_RETAINED_RESPONSES = 200;

export type ResponseChoiceStatus = 'sending' | 'sent' | 'unknown';

interface ResponseChoiceEntry {
	readonly chatId: string;
	readonly status: ResponseChoiceStatus;
}

export class ResponseChoiceController {
	readonly #responses = new SvelteMap<string, ResponseChoiceEntry>();

	status(key: string): ResponseChoiceStatus | undefined {
		return this.#responses.get(key)?.status;
	}

	async submit(key: string, chatId: string, send: () => Promise<boolean>): Promise<boolean> {
		const existing = this.#responses.get(key);
		if (existing) {
			this.#retain(key, existing);
			return false;
		}
		if (this.#responses.size >= MAX_RETAINED_RESPONSES && !this.#evictCompleted()) {
			throw new Error(m.chat_async_capacity_exhausted());
		}
		const pending: ResponseChoiceEntry = { chatId, status: 'sending' };
		this.#retain(key, pending);
		try {
			const accepted = await send();
			if (this.#responses.get(key) === pending) {
				if (accepted) this.#retain(key, { chatId, status: 'sent' });
				else this.#responses.delete(key);
			}
			return accepted;
		} catch (error) {
			if (this.#responses.get(key) === pending) {
				if (error instanceof CommandOutcomeUnknownError) {
					this.#retain(key, { chatId, status: 'unknown' });
				} else {
					this.#responses.delete(key);
				}
			}
			throw error;
		}
	}

	prune(chats: ReadonlySet<string>): void {
		for (const [key, entry] of this.#responses) {
			if (!chats.has(entry.chatId)) this.#responses.delete(key);
		}
	}

	#retain(key: string, entry: ResponseChoiceEntry): void {
		this.#responses.delete(key);
		this.#responses.set(key, entry);
	}

	#evictCompleted(): boolean {
		for (const [key, entry] of this.#responses) {
			if (entry.status !== 'sent') continue;
			this.#responses.delete(key);
			return true;
		}
		return false;
	}
}
