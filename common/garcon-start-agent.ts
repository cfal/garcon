import { parseGarconCommandEnvelope } from './garcon-command-envelope.js';
import { parseChatRowTitle } from './chat-row-contracts.js';
import { GARCON_AGENT_PROMPT_MAX_BYTES, parseGarconAgentRequestOptions, type GarconAgentRequestOptions } from './garcon-agent-request.js';

export const GARCON_START_AGENT_NAME = 'garcon-start-agent';
export const GARCON_START_PROMPT_MAX_BYTES = GARCON_AGENT_PROMPT_MAX_BYTES;

export interface GarconStartAgentCommand extends GarconAgentRequestOptions {
  readonly type: 'start-agent';
  readonly agentId: string;
  readonly providerId: string | null;
  readonly model: string;
  readonly reasoningEffort: string | null;
  readonly prompt: string;
  readonly fork: boolean;
  readonly title: string | null;
}

export function parseGarconStartAgent(content: string): GarconStartAgentCommand | null {
  const envelope = parseGarconCommandEnvelope(content, GARCON_START_AGENT_NAME, [
    'agent', 'provider', 'model', 'reasoning-effort', 'ref', 'async', 'fork', 'title',
  ]);
  if (!envelope || !envelope.body.trim() || envelope.selfClosing) return null;
  const { attributes, body } = envelope;
  const options = parseGarconAgentRequestOptions(attributes);
  if (!options || attributes.fork !== undefined && attributes.fork !== 'true' && attributes.fork !== 'false') return null;
  let title: string | null;
  try { title = parseChatRowTitle(attributes.title) ?? null; } catch { return null; }
  if (!attributes.agent || !attributes.model || new TextEncoder().encode(body).byteLength > GARCON_START_PROMPT_MAX_BYTES) return null;
  return {
    type: 'start-agent',
    ...options,
    fork: attributes.fork === 'true',
    title,
    agentId: attributes.agent,
    providerId: attributes.provider ?? null,
    model: attributes.model,
    reasoningEffort: attributes['reasoning-effort'] ?? null,
    prompt: body,
  };
}
