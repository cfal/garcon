// Converts Claude CLI permission request payloads into canonical
// ToolUseMessage subclasses. Delegates to the existing tool-use
// converter since permission requests share the same name+input shape.

import { convertClaudeToolUse } from './tool-use-converter.js';
import type { ToolUseChatMessage } from '../../../common/chat-types.js';

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
