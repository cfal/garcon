import {
  antigravityToolCall,
  convertAntigravityToolUse,
} from '../../../../server-agents/antigravity/src/agents/antigravity/tool-use-converter.ts';

export { antigravityToolCall, antigravityToolResultText } from '../../../../server-agents/antigravity/src/agents/antigravity/tool-use-converter.ts';

export function convertAntigravityToolUpdate(timestamp: string, raw: Record<string, unknown>) {
  const call = antigravityToolCall(raw);
  return call ? convertAntigravityToolUse(timestamp, call) : null;
}
