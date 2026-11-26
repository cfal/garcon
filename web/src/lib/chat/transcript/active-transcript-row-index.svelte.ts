import type { ChatMessage, ToolResultMessage } from '$shared/chat-types';
import type { TranscriptMessage } from '$shared/chat-view';

type QuestionAnswer = Extract<ChatMessage, { type: 'user-message' }>;

export class ActiveTranscriptRowIndex {
	lastOwnershipBoundary = $state(0);
	questionAnswers = $state.raw<readonly QuestionAnswer[]>([]);
	subagentMessages = $state.raw<ChatMessage[]>([]);
	hasSubagentEvents = $state(false);
	#subagentToolIds = new Set<string>();
	// Keeps the latest result for each unmatched ID within the loaded window.
	#unmatchedResults = new Map<string, ToolResultMessage>();

	replace(entries: readonly TranscriptMessage[]): void {
		this.lastOwnershipBoundary = 0;
		this.questionAnswers = [];
		this.subagentMessages = [];
		this.hasSubagentEvents = false;
		this.#subagentToolIds.clear();
		this.#unmatchedResults.clear();
		this.append(entries);
	}

	append(entries: readonly TranscriptMessage[], start = 0): void {
		let boundary = this.lastOwnershipBoundary;
		let answers: QuestionAnswer[] | undefined;
		let subagentMessages: ChatMessage[] | undefined;
		for (let index = start; index < entries.length; index++) {
			const { ordinal, message } = entries[index];
			switch (message.type) {
				case 'agent-switch':
					boundary = ordinal;
					break;
				case 'user-message':
					if (message.metadata?.questionReply) (answers ??= []).push(message);
					(subagentMessages ??= []).push(message);
					break;
				case 'codex-subagent-tool-use': {
					this.#subagentToolIds.add(message.toolId);
					const result = this.#unmatchedResults.get(message.toolId);
					if (result) {
						(subagentMessages ??= []).push(result);
						this.#unmatchedResults.delete(message.toolId);
					}
					(subagentMessages ??= []).push(message);
					break;
				}
				case 'tool-result':
					if (this.#subagentToolIds.has(message.toolId)) (subagentMessages ??= []).push(message);
					else this.#unmatchedResults.set(message.toolId, message);
					break;
			}
		}
		this.lastOwnershipBoundary = boundary;
		this.hasSubagentEvents = this.#subagentToolIds.size > 0;
		if (answers) this.questionAnswers = [...this.questionAnswers, ...answers];
		if (subagentMessages) this.subagentMessages = [...this.subagentMessages, ...subagentMessages];
	}
}
