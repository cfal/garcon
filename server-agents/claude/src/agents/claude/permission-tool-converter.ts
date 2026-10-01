import { convertClaudeToolUse } from './tool-use-converter.js';
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
    requestedTool: convertClaudeToolUse(ts, {
      id: request.tool_use_id ?? permissionOccurrenceId,
      name: request.tool_name || 'Unknown',
      input: request.input,
    }),
    options: [],
    ...(reason ? { reason } : {}),
  };
}
