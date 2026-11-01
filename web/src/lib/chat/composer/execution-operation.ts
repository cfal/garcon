import type { ChatSessionRecord } from '../sessions/chat-session-types';
import { isClearCommand, isControllerSlashCommand } from './slash-commands';

export function isComposerControllerCommand(
	chat: Pick<ChatSessionRecord, 'status'> | null | undefined,
	input: string,
	policy: 'conversation' | 'literal' | null,
): boolean {
	if (chat?.status !== 'running') return false;
	return isClearCommand(input) || (policy !== null && isControllerSlashCommand(input, policy));
}
