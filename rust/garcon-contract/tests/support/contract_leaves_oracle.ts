import type { ChatDetailsResponse } from "../../../../common/chat-details.ts";
import type { PublicSharedChatSnapshot } from "../../../../common/share-types.ts";
import type { PersistedWorkspaceLayoutV2 } from "../../../../common/workspace-layout.ts";
import { AGENT_HANDOFF_HTTP_TIMEOUT_MS, AGENT_HANDOFF_REQUEST_TIMEOUT_SECONDS } from "../../../../common/handoff-timeouts.ts";

export { parseCommandQuestionReply, parseCommandUserMessagePresentation, rejectQuestionReply } from "../../../../common/chat-input-command-parsing.ts";
export { generationModelTestConfigurationKey, isGenerationTestTarget } from "../../../../common/generation-test-contracts.ts";
export { isGenerateGitNameRequest } from "../../../../common/git-name.ts";
export { nextRunOrSteerRoute } from "../../../../common/run-or-steer.ts";
export { renderRuntimeShell } from "../../../../common/runtime-shell.ts";

export function handoffTimeouts(): [number, number] {
  return [AGENT_HANDOFF_HTTP_TIMEOUT_MS, AGENT_HANDOFF_REQUEST_TIMEOUT_SECONDS];
}

export function chatDetailsWire(details: ChatDetailsResponse): string {
  return JSON.stringify(details);
}

export function workspaceLayoutWire(layout: PersistedWorkspaceLayoutV2): string {
  return JSON.stringify(layout);
}

export function publicSharedSnapshotWire(raw: PublicSharedChatSnapshot): string {
  const { shareToken, title, agentId, model, sharedAt, frozenMessageCount, messages } = raw;
  return JSON.stringify({ shareToken, title, agentId, model, sharedAt, frozenMessageCount, messages });
}
