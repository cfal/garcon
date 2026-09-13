import { isRecord } from '@garcon/common/json';

type ClaudeContextControlRequest =
  | { subtype: 'get_settings' }
  | { subtype: 'apply_flag_settings'; settings: { env: Record<string, string> } }
  | { subtype: 'set_model'; model: string }
  | { subtype: 'get_context_usage' };

type RequestControl = (request: ClaudeContextControlRequest) => Promise<unknown>;

export async function updateClaudeContextWindow(
  request: RequestControl,
  currentModel: string,
  model: string,
  autoCompactWindow: number,
): Promise<void> {
  const env = flagSettingsEnvironment(await request({ subtype: 'get_settings' }));

  // Claude 2.1.238/2.1.269 ACK direct autoCompactWindow settings without updating
  // the live budget. Their stdin-only env control works; /autocompact writes shared settings.
  // https://code.claude.com/docs/en/model-config#set-the-auto-compact-window
  await request({
    subtype: 'apply_flag_settings',
    settings: { env: { ...env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(autoCompactWindow) } },
  });
  if (model !== currentModel) await request({ subtype: 'set_model', model });

  // ACKs can succeed without applying settings, including under managed env policy.
  // The pinned CLI suite verifies this private protocol against the actual compaction budget.
  const usage = await request({ subtype: 'get_context_usage' });
  if (
    !isRecord(usage)
    || usage.model !== model
    || usage.autocompactSource !== 'env'
    || usage.rawMaxTokens !== autoCompactWindow
  ) {
    throw new Error('Claude CLI did not apply the requested context window');
  }
}

function flagSettingsEnvironment(response: unknown): Record<string, string> {
  if (!isRecord(response) || !Array.isArray(response.sources)) {
    throw new Error('Claude CLI returned invalid settings sources');
  }
  const sources = response.sources;
  if (!sources.every(source => isRecord(source) && typeof source.source === 'string')) {
    throw new Error('Claude CLI returned invalid settings sources');
  }
  const flagSources = sources.filter(source => source.source === 'flagSettings');
  if (flagSources.length === 0) return {};
  if (flagSources.length !== 1 || !isRecord(flagSources[0].settings)) {
    throw new Error('Claude CLI returned invalid flag settings');
  }
  const env = flagSources[0].settings.env;
  if (env === undefined) return {};
  if (!isRecord(env)) throw new Error('Claude CLI returned invalid flag environment');

  // apply_flag_settings replaces the nested env object rather than merging its keys.
  return Object.fromEntries(Object.entries(env).map(([key, value]) => {
    if (typeof value !== 'string') throw new Error('Claude CLI returned invalid flag environment');
    return [key, value];
  }));
}
