import { parseGarconCommandEnvelope } from './garcon-command-envelope.js';

export const GARCON_START_AGENT_NAME = 'garcon-start-agent';
export const GARCON_START_PROMPT_MAX_BYTES = 48 * 1024;

export interface GarconStartAgentCommand {
  readonly type: 'start-agent';
  readonly agentId: string;
  readonly providerId: string | null;
  readonly model: string;
  readonly reasoningEffort: string | null;
  readonly prompt: string;
}

export function parseGarconStartAgent(content: string): GarconStartAgentCommand | null {
  const envelope = parseGarconCommandEnvelope(content, GARCON_START_AGENT_NAME, [
    'agent', 'provider', 'model', 'reasoning-effort',
  ]);
  if (!envelope || !envelope.body.trim() || envelope.selfClosing) return null;
  const { attributes, body } = envelope;
  if (!attributes.agent || !attributes.model || new TextEncoder().encode(body).byteLength > GARCON_START_PROMPT_MAX_BYTES) return null;
  return {
    type: 'start-agent',
    agentId: attributes.agent,
    providerId: attributes.provider ?? null,
    model: attributes.model,
    reasoningEffort: attributes['reasoning-effort'] ?? null,
    prompt: body,
  };
}
