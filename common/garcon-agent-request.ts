export interface GarconAgentRequestOptions {
  readonly ref: string;
  readonly async: boolean;
}

export const GARCON_AGENT_REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const GARCON_AGENT_PROMPT_MAX_BYTES = 48 * 1024;

export function parseGarconAgentRequestOptions(
  attributes: Readonly<Record<string, string>>,
): GarconAgentRequestOptions | null {
  if (!attributes.ref || !GARCON_AGENT_REF.test(attributes.ref)) return null;
  if (attributes.async !== undefined && attributes.async !== 'true' && attributes.async !== 'false') return null;
  return { ref: attributes.ref, async: attributes.async === 'true' };
}
