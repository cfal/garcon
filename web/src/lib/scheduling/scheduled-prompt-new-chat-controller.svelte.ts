import { renderScheduledPrompt } from '$lib/api/scheduled-prompts';
import type { NewChatDialogSeed, NewChatStartupSeed } from '$lib/chat/new-chat/new-chat-seed';
import { createClientChatId } from '$shared/client-chat-id';
import type { ScheduledPrompt } from '$shared/scheduled-prompts';
import * as m from '$lib/paraglide/messages.js';

export interface ScheduledPromptNewChatControllerDeps {
	readonly active: boolean;
	readonly newChatRequestId: number;
	startupFor(prompt: ScheduledPrompt): NewChatStartupSeed | null;
	open(seed: NewChatDialogSeed): void;
	render?: typeof renderScheduledPrompt;
}

export class ScheduledPromptNewChatController {
	openingPromptId = $state<string | null>(null);
	error = $state<string | null>(null);
	#abort: AbortController | null = null;

	constructor(private readonly deps: ScheduledPromptNewChatControllerDeps) {}

	cancel(): void {
		this.#abort?.abort();
		this.#abort = null;
		this.openingPromptId = null;
	}

	async open(prompt: ScheduledPrompt): Promise<void> {
		if (this.openingPromptId || !this.deps.active) return;
		const startup = this.deps.startupFor(prompt);
		if (!startup) return;
		const requestId = this.deps.newChatRequestId;
		const abort = new AbortController();
		this.#abort = abort;
		this.openingPromptId = prompt.id;
		this.error = null;
		const current = () => !abort.signal.aborted && this.deps.active && requestId === this.deps.newChatRequestId;
		try {
			const chatId = createClientChatId();
			const result = await (this.deps.render ?? renderScheduledPrompt)(
				{ chatId, prompt: prompt.prompt }, { signal: abort.signal },
			);
			if (!current()) return;
			if (JSON.stringify(this.deps.startupFor(prompt)) !== JSON.stringify(startup)) {
				this.error = m.scheduled_prompts_target_changed();
				return;
			}
			this.deps.open({ prefill: result.expandedText, prospectiveChatId: chatId, startup });
		} catch (error) {
			if (current()) this.error = error instanceof Error ? error.message : m.scheduled_prompts_open_new_chat_error();
		} finally {
			if (this.#abort === abort) {
				this.#abort = null;
				this.openingPromptId = null;
			}
		}
	}
}
