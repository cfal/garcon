import type { ChatSessionRecord } from '../sessions/chat-session-types';
import { isClearCommand, isControllerSlashCommand, parseCompactCommand } from './slash-commands';
import { parseHandoffCommand } from './handoff-command';
import { parseForkCommand } from './fork-command';

export function isComposerControllerCommand(
	chat: Pick<ChatSessionRecord, 'status'> | null | undefined,
	input: string,
	policy: 'conversation' | 'literal' | null,
): boolean {
	if (chat?.status !== 'running') return false;
	return isClearCommand(input) || (policy !== null && isControllerSlashCommand(input, policy));
}

export function composerExecutionOperations(chat: Pick<ChatSessionRecord, 'status' | 'hasAgentSession'> | null | undefined,
	input: string, provider: { executionPolicy: 'conversation' | 'literal'; supportsFork: boolean }): readonly ('execution.start' | 'execution.resume' | 'compaction.compact')[] {
	if (provider.executionPolicy === 'conversation' && chat?.status !== 'draft') {
		if (parseCompactCommand(input)) return ['compaction.compact'];
		if (parseHandoffCommand(input)) return ['execution.start'];
		const fork = provider.supportsFork ? parseForkCommand(input) : null;
		if (fork) return fork.message ? ['execution.start', 'execution.resume'] : [];
	}
	return [chat?.status !== 'draft' && chat?.hasAgentSession ? 'execution.resume' : 'execution.start'];
}
