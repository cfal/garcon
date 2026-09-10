import type { SharedModelOption } from '@garcon/common/models';

export function piModelToOption(model: unknown): SharedModelOption | null {
  if (!model || typeof model !== 'object' || Array.isArray(model)) return null;
  const candidate = model as { provider?: unknown; id?: unknown; input?: unknown };
  if (typeof candidate.provider !== 'string' || !candidate.provider.trim()
    || typeof candidate.id !== 'string' || !candidate.id.trim()) return null;
  const tokens = candidate.id.split('/').filter(Boolean);
  const shortId = tokens[tokens.length - 1] || candidate.id;
  return {
    value: `${candidate.provider}/${candidate.id}`,
    label: `${candidate.provider}: ${shortId}`,
    supportsImages: Array.isArray(candidate.input) && candidate.input.includes('image'),
  };
}
