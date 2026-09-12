import { AgentIntegrationError } from '@garcon/server-agent-interface';

interface ClaudeModelContext {
  readonly model: string;
  readonly autoCompactWindow: number | null;
}

export function resolveClaudeModel(model: string): ClaudeModelContext {
  const match = /^(.*)\[(\d+)k\]$/i.exec(model);
  const autoCompactWindow = match ? Number(match[2]) * 1_000 : null;
  const validBrackets = !/[\[\]]/.test(model) || /^[^\[\]]+\[[^\[\]]+\]$/.test(model);
  if (
    !validBrackets
    || (match && !match[1].trim())
    || (autoCompactWindow !== null && (autoCompactWindow < 100_000 || autoCompactWindow > 1_000_000))
  ) {
    throw new AgentIntegrationError(
      'INVALID_SETTINGS',
      'Claude model context suffix requires a model followed by [100k] through [1000k].',
      false,
    );
  }
  if (!match) return { model, autoCompactWindow: null };

  // The flag caps compaction but cannot enlarge an unknown model's default 200K window.
  // https://code.claude.com/docs/en/model-config#correct-the-window-for-a-gateway-or-custom-model-id
  return { model: `${match[1]}[1m]`, autoCompactWindow };
}
