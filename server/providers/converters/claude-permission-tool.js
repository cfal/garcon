// Converts Claude CLI permission request payloads into canonical
// ToolUseMessage subclasses. Delegates to the existing tool-use
// converter since permission requests share the same name+input shape.

import { convertClaudeToolUse } from './claude-tool-use.js';

/**
 * Converts a Claude permission request's tool name and input into a
 * canonical ToolUseChatMessage. The permission converter reuses the
 * tool-use converter directly because Claude permission requests carry
 * the same raw name and input shape as tool_use content blocks.
 */
export function convertClaudePermissionTool(ts, toolId, rawToolName, rawInput) {
  return convertClaudeToolUse(ts, {
    id: toolId,
    name: rawToolName,
    input: rawInput,
  });
}
