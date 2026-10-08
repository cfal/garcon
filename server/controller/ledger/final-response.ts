import type { AgentFinalResponse } from '@garcon/server-agent-interface';
import { AssistantMessage } from '../../../common/chat-types.js';
import { extractGarconCommands } from '../../../common/garcon-commands.js';

export function projectFinalResponse(value: unknown): AgentFinalResponse | null {
  // Optional response metadata must never prevent terminal publication.
  try {
    if (!value || typeof value !== 'object' || !('type' in value)
      || (value.type !== 'text' && value.type !== 'literal-text')
      || !('text' in value) || typeof value.text !== 'string') return null;
    if (value.type === 'literal-text') return { type: 'literal-text', text: value.text };
    const projected = extractGarconCommands(new AssistantMessage('', value.text));
    return { type: 'text', text: projected ? projected.message?.content ?? '' : value.text };
  } catch {
    return null;
  }
}
