import { parseChatId } from './chat-id.js';
import { parseGarconCommandEnvelope } from './garcon-command-envelope.js';
import { GARCON_AGENT_PROMPT_MAX_BYTES, parseGarconAgentRequestOptions, type GarconAgentRequestOptions } from './garcon-agent-request.js';

export const GARCON_RESUME_AGENT_NAME = 'garcon-resume-agent';

export interface GarconResumeAgentCommand extends GarconAgentRequestOptions {
  readonly type: 'resume-agent';
  readonly chatId: string;
  readonly prompt: string;
}

export function parseGarconResumeAgent(content: string): GarconResumeAgentCommand | null {
  const envelope = parseGarconCommandEnvelope(content, GARCON_RESUME_AGENT_NAME, ['ref', 'async', 'chat-id']);
  if (!envelope || envelope.selfClosing || !envelope.body.trim()
    || new TextEncoder().encode(envelope.body).byteLength > GARCON_AGENT_PROMPT_MAX_BYTES) return null;
  const options = parseGarconAgentRequestOptions(envelope.attributes);
  if (!options) return null;
  try {
    return { type: 'resume-agent', ...options, chatId: parseChatId(envelope.attributes['chat-id']), prompt: envelope.body };
  } catch { return null; }
}
