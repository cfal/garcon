import type { ChatMessage } from '$shared/chat-types';
import type { TranscriptMessage } from '$shared/chat-view';

type QuestionAnswer = Extract<ChatMessage, { type: 'user-message' }>;

export class ActiveTranscriptRowIndex {
	lastOwnershipBoundary = $state(0);
	questionAnswers = $state.raw<readonly QuestionAnswer[]>([]);
	subagentMessages = $state.raw<ChatMessage[]>([]);
	hasSubagentEvents = $state(false);
	#subagentToolIds = new Set<string>();

	replace(entries: readonly TranscriptMessage[]): void {
		this.lastOwnershipBoundary = 0;
		this.questionAnswers = [];
		this.subagentMessages = [];
		this.hasSubagentEvents = false;
		this.#subagentToolIds.clear();
		this.append(entries);
	}

	append(entries: readonly TranscriptMessage[], start = 0): void {
		let boundary = this.lastOwnershipBoundary;
		let answers: QuestionAnswer[] | undefined;
		let subagentMessages: ChatMessage[] | undefined;
		let newSubagentToolIds: Set<string> | undefined;
		for (let index = start; index < entries.length; index++) {
			const { ordinal, message } = entries[index];
			if (message.type === 'agent-switch') boundary = ordinal;
			if (message.type === 'user-message' && message.metadata?.questionReply) {
				(answers ??= []).push(message);
			}
			if (message.type === 'codex-subagent-tool-use' && !this.#subagentToolIds.has(message.toolId)) {
				this.#subagentToolIds.add(message.toolId);
				(newSubagentToolIds ??= new Set()).add(message.toolId);
			}
		}
		this.lastOwnershipBoundary = boundary;
		this.hasSubagentEvents = this.#subagentToolIds.size > 0;
		if (answers) this.questionAnswers = [...this.questionAnswers, ...answers];
		// The reducer pairs each call with the last result for its tool ID, including
		// results that may have arrived in an earlier retained page.
		if (newSubagentToolIds && start > 0) {
			for (let index = start - 1; index >= 0 && newSubagentToolIds.size > 0; index--) {
				const { message } = entries[index];
				if (message.type === 'tool-result' && newSubagentToolIds.delete(message.toolId)) {
					(subagentMessages ??= []).push(message);
				}
			}
		}
		for (let index = start; index < entries.length; index++) {
			const { message } = entries[index];
			if (message.type === 'codex-subagent-tool-use' || message.type === 'user-message'
				|| (message.type === 'tool-result' && this.#subagentToolIds.has(message.toolId))) {
				(subagentMessages ??= []).push(message);
			}
		}
		if (subagentMessages) this.subagentMessages = [...this.subagentMessages, ...subagentMessages];
	}
}
