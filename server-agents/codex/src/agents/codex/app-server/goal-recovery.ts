import type { CodexAppServerClient } from './client.js';
import { cleanupMaterializedGoalDraft, type MaterializedGoalDraft } from './goal-files.js';
import type { CodexThreadGoal, ThreadGoalSetResponse } from './protocol.js';

export async function recoverGoalDraftAfterError(
  client: CodexAppServerClient,
  threadId: string,
  draft: MaterializedGoalDraft,
  deliveryError: unknown,
  onCleanupError: (error: unknown) => void,
  cleanupDraft: typeof cleanupMaterializedGoalDraft = cleanupMaterializedGoalDraft,
): Promise<ThreadGoalSetResponse> {
  let goal: CodexThreadGoal | null;
  try {
    goal = (await client.getThreadGoal(threadId)).goal;
  } catch {
    throw deliveryError;
  }
  if (goal?.objective === draft.objective) return { goal };
  try {
    await cleanupDraft(draft.outputDir);
  } catch (error) {
    onCleanupError(error);
  }
  throw deliveryError;
}
