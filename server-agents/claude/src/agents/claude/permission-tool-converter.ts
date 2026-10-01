// Converts Claude CLI permission request payloads into canonical
// ToolUseMessage subclasses. Delegates to the existing tool-use
// converter since permission requests share the same name+input shape.

import { convertClaudeToolUse } from './tool-use-converter.js';
import type { ToolUseChatMessage } from '@garcon/common/chat-types';
import type { AgentPermissionLifecycle } from '@garcon/server-agent-interface';
import type { ClaudeCLIMessage } from './cli-protocol.js';

export function convertClaudePermissionRequest(
  ts: string,
  permissionOccurrenceId: string,
  request: NonNullable<ClaudeCLIMessage['request']>,
): Extract<AgentPermissionLifecycle, { kind: 'requested' }> {
  // Claude Code explains requests it raises despite bypass mode, such as its dangerous-removal check.
  const reason = typeof request.decision_reason === 'string' ? request.decision_reason.trim() : '';
  return {
    kind: 'requested',
    permissionOccurrenceId,
    requestedTool: convertClaudePermissionTool(
      ts,
      request.tool_use_id ?? permissionOccurrenceId,
      request.tool_name || 'Unknown',
      request.input,
    ),
    options: [],
    ...(reason ? { reason } : {}),
  };
}

/**
 * Converts a Claude permission request's tool name and input into a
 * canonical ToolUseChatMessage. The permission converter reuses the
 * tool-use converter directly because Claude permission requests carry
 * the same raw name and input shape as tool_use content blocks.
 */
export function convertClaudePermissionTool(
  ts: string,
  toolId: string,
  rawToolName: unknown,
  rawInput: unknown,
): ToolUseChatMessage {
  return convertClaudeToolUse(ts, {
    id: toolId,
    name: rawToolName,
    input: rawInput,
  });
}
