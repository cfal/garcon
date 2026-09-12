import { AgentIntegrationError } from '@garcon/server-agent-interface';

interface ClaudeModelContext {
  readonly model: string;
  readonly autoCompactWindow: number | null;
}

export function resolveClaudeModel(model: string): ClaudeModelContext {
  if (/[\[\]]/.test(model) && !/^[^\[\]]+\[[^\[\]]+\]$/.test(model)) {
    throw invalidContextSuffix();
  }

  const match = /^(.*)\[(\d+)k\]$/i.exec(model);
  if (!match) return { model, autoCompactWindow: null };

  const [, baseModel, thousands] = match;
  const autoCompactWindow = Number(thousands) * 1_000;
  if (!baseModel.trim() || autoCompactWindow < 100_000 || autoCompactWindow > 1_000_000) {
    throw invalidContextSuffix();
  }

  // The flag caps compaction but cannot enlarge an unknown model's default 200K window.
  // https://code.claude.com/docs/en/model-config#correct-the-window-for-a-gateway-or-custom-model-id
  return { model: `${baseModel}[1m]`, autoCompactWindow };
}

function invalidContextSuffix(): AgentIntegrationError {
  return new AgentIntegrationError(
    'INVALID_SETTINGS',
    'Claude model context suffix requires a model followed by [100k] through [1000k].',
    false,
  );
}
