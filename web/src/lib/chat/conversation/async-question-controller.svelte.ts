import { SvelteMap } from 'svelte/reactivity';
import type { AsyncQuestionPrompt, AsyncQuestionReply } from '$shared/async-user-questions';
import { CommandOutcomeUnknownError } from './idempotent-command.js';
import { submitAsyncQuestionReply, type AsyncQuestionTarget } from './async-question-submission.js';
import type { QuestionDraft } from './question-draft.js';

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

	get(key: string): AsyncQuestionDraft | undefined { return this.#drafts.get(key); }

	set(key: string, entry: AsyncQuestionDraft): void {
		this.#drafts.delete(key);
		this.#drafts.set(key, entry);
		// Bounded tab-local retention survives virtualization and chat switches.
		while (this.#drafts.size > 200) this.#drafts.delete(this.#drafts.keys().next().value!);
	}

	edit(key: string, target: AsyncQuestionTarget, draft: QuestionDraft): void {
		this.set(key, { target, draft });
	}

	retainView(chatId: string, view: string): void {
		for (const [key, entry] of this.#drafts) {
			if (entry.target.chatId === chatId && entry.target.transcriptViewId !== view) this.#drafts.delete(key);
		}
	}

	prune(chats: ReadonlySet<string>): void {
		for (const [key, entry] of this.#drafts) if (!chats.has(entry.target.chatId)) this.#drafts.delete(key);
	}

	async submit(target: AsyncQuestionTarget, ordinal: number, question: AsyncQuestionPrompt, answer: string): Promise<void> {
		const key = asyncQuestionDraftKey(target, ordinal, question.id);
		if (this.get(key)?.status === 'sending') return;
		const pending: AsyncQuestionDraft = { ...this.get(key), target, status: 'sending' };
		this.set(key, pending);
		const reply: AsyncQuestionReply = {
			questionId: question.id, question: question.prompt, answer,
			source: { chatId: target.chatId, transcriptViewId: target.transcriptViewId, ordinal },
		};
		try {
			const delivery = await this.send(target, reply);
			if (this.get(key) === pending) this.set(key, {
				target, status: 'sent', message: delivery === 'steer' ? 'Sent to active turn' : 'Started new turn',
			});
		} catch (error) {
			if (this.get(key) !== pending) return;
			const unknown = error instanceof CommandOutcomeUnknownError;
			this.set(key, { ...pending, status: unknown ? 'unknown' : 'failed', message: unknown
				? 'Delivery unconfirmed. Check the conversation before sending again.'
				: error instanceof Error ? error.message : 'Answer could not be sent' });
		}
	}
}
