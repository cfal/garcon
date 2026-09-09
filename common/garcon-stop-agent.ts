import { parseChatId, type ChatId } from './chat-id.js';
import { parseGarconCommandEnvelope } from './garcon-command-envelope.js';

export interface GarconStopAgentCommand {
  readonly type: 'stop-agent';
  readonly chatId: ChatId;
  readonly remove: boolean;
}

export function parseGarconStopAgent(content: string): GarconStopAgentCommand | null {
  const envelope = parseGarconCommandEnvelope(content, 'garcon-stop-agent', ['chat-id', 'remove']);
  if (!envelope?.selfClosing) return null;
  const remove = envelope.attributes.remove;
  if (remove !== undefined && remove !== 'true' && remove !== 'false') return null;
  try {
    return {
      type: 'stop-agent',
      chatId: parseChatId(envelope.attributes['chat-id']),
      remove: remove === 'true',
    };
  } catch {
    return null;
  }
}
