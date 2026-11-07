import { SvelteMap } from 'svelte/reactivity';
import type { AsyncQuestionPrompt, AsyncQuestionReply } from '$shared/async-user-questions';
import { CommandOutcomeUnknownError } from './idempotent-command.js';
import { submitAsyncQuestionReply, type AsyncQuestionTarget } from './async-question-submission.js';
import type { QuestionDraft } from './question-draft.js';
import * as m from '$lib/paraglide/messages.js';

const MAX_RETAINED_DRAFTS = 200;

export interface AsyncQuestionDraft {
	target: AsyncQuestionTarget;
	draft?: QuestionDraft;
	dismissed?: boolean;
	status?: 'sending' | 'sent' | 'failed' | 'unknown';
	message?: string;
}

export function asyncQuestionDraftKey(target: AsyncQuestionTarget, ordinal: number, questionId: string): string {
	return JSON.stringify([target.chatId, target.transcriptViewId, ordinal, questionId]);
}

export class AsyncQuestionController {
	readonly #drafts = new SvelteMap<string, AsyncQuestionDraft>();
	constructor(private readonly send = submitAsyncQuestionReply) {}

	get(key: string): AsyncQuestionDraft | undefined {
		return this.#drafts.get(key);
	}

	canRetain(key: string): boolean {
		return this.#drafts.has(key)
			|| this.#drafts.size < MAX_RETAINED_DRAFTS
			|| this.#oldestEvictableKey() !== undefined;
	}

	#oldestEvictableKey(): string | undefined {
		// Pending entries retain the duplicate-submit fence until delivery settles.
		for (const [key, entry] of this.#drafts) {
			if (entry.status !== 'sending') return key;
		}
		return undefined;
	}

	#set(key: string, entry: AsyncQuestionDraft): boolean {
		if (!this.#drafts.has(key) && this.#drafts.size >= MAX_RETAINED_DRAFTS) {
			const evictableKey = this.#oldestEvictableKey();
			if (evictableKey === undefined) return false;
			this.#drafts.delete(evictableKey);
		}
		// Re-insertion refreshes recency without mutating an in-flight entry.
		this.#drafts.delete(key);
		this.#drafts.set(key, entry);
		return true;
	}

	edit(key: string, target: AsyncQuestionTarget, draft: QuestionDraft): void {
		if (this.get(key)?.status === 'sending') return;
		this.#set(key, { target, draft });
	}

	dismiss(key: string, target: AsyncQuestionTarget, draft: QuestionDraft): void {
		const entry = this.get(key);
		if (entry?.status === 'sending') return;
		this.#set(key, { ...entry, target, draft, dismissed: true });
	}

	retainView(chatId: string, view: string): void {
		for (const [key, entry] of this.#drafts) {
			if (entry.target.chatId === chatId && entry.target.transcriptViewId !== view) {
				this.#drafts.delete(key);
			}
		}
	}

	prune(chats: ReadonlySet<string>): void {
		for (const [key, entry] of this.#drafts) {
			if (!chats.has(entry.target.chatId)) this.#drafts.delete(key);
		}
	}

	async submit(
		target: AsyncQuestionTarget,
		ordinal: number,
		question: AsyncQuestionPrompt,
		answer: string,
		excludedResendOrdinals: readonly number[] = [],
	): Promise<void> {
		const key = asyncQuestionDraftKey(target, ordinal, question.id);
		const entry = this.get(key);
		if (entry?.status === 'sending') return;
		const pending: AsyncQuestionDraft = { ...entry, target, status: 'sending' };
		if (!this.#set(key, pending)) return;
		const reply: AsyncQuestionReply = {
			questionId: question.id,
			question: question.prompt,
			answer,
			source: { chatId: target.chatId, transcriptViewId: target.transcriptViewId, ordinal },
		};
		try {
			const delivery = await this.send(target, reply, excludedResendOrdinals);
			if (this.get(key) !== pending) return;
			this.#set(key, {
				target,
				status: 'sent',
				message: delivery === 'steer' ? m.chat_async_sent_to_turn() : m.chat_async_started_turn(),
			});
		} catch (error) {
			if (this.get(key) !== pending) return;
			if (error instanceof CommandOutcomeUnknownError) {
				this.#set(key, {
					...pending,
					status: 'unknown',
					message: m.chat_async_delivery_unconfirmed(),
				});
			} else {
				this.#set(key, {
					...pending,
					status: 'failed',
					message: error instanceof Error ? error.message : m.chat_async_send_failed(),
				});
			}
		}
	}
}
