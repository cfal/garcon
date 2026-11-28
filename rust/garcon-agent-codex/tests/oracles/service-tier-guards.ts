import { CODEX_SPEED_SETTING, codexServiceTier, codexSpeed } from '../../../../server-agents/codex/src/agents/codex/service-tier.ts';

export function acceptsSpeed(speed: unknown): boolean {
  codexSpeed({ ownerId: 'codex', schemaVersion: 1, values: { speed } });
  return true;
}

export function acceptsTier(tier: unknown): boolean {
  return CODEX_SPEED_SETTING.options.some(({ value }) => codexServiceTier(value) === tier);
}
