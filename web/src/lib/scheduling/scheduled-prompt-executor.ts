import { effectiveExecutorId } from '$shared/executors';
import type { ScheduledPrompt } from '$shared/scheduled-prompts';

// Existing-chat prompts run wherever their chat runs, so a missing chat leaves
// the executor unknown rather than Local.
export function scheduledPromptExecutorId(
	scheduledPrompt: ScheduledPrompt,
	existingChat: { readonly executorId?: string | null } | undefined,
): string | null {
	if (scheduledPrompt.target.type === 'new-chat') {
		return effectiveExecutorId(scheduledPrompt.target.executorId);
	}
	return existingChat ? effectiveExecutorId(existingChat.executorId) : null;
}
