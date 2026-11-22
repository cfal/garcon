import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentLogger } from '@garcon/server-agent-interface';
import { CliUpdateService } from '@garcon/server-agent-common/cli-update/cli-update-service';
import { channelLatestVersion } from '@garcon/server-agent-common/cli-update/latest-version';
import { isRecord } from '@garcon/common/json';
import type { ClaudeConfig } from '../../config.js';
import { claudeConfigHomeDir } from './native-path.js';
import { installerEnvironment } from '@garcon/server-agent-common/cli-update/installer-environment';
import type { ClaudeCliVersionProbe } from './cli-version.js';

const CLAUDE_RELEASES_URL = 'https://downloads.claude.ai/claude-code-releases';
// CLAUDECODE would mark the updater as running inside a Claude session.
const CLAUDE_CREDENTIAL_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE'];

// Managed settings override the user's release channel.
const MANAGED_SETTINGS_PATHS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: '/Library/Application Support/ClaudeCode/managed-settings.json',
  linux: '/etc/claude-code/managed-settings.json',
};

export function createClaudeCliUpdates(options: {
  readonly config: ClaudeConfig;
  readonly versionProbe: ClaudeCliVersionProbe;
  readonly logger: AgentLogger;
}): CliUpdateService {
  const { config } = options;
  return new CliUpdateService({
    label: 'Claude Code',
    definition: {
      packageName: '@anthropic-ai/claude-code',
      native: {
        // The native launcher links into ${XDG_DATA_HOME:-~/.local/share}/claude/versions;
        // a plain file at ~/.local/bin/claude is a wrapper that `claude update` cannot see.
        // https://github.com/pingdotgg/t3code/blob/be9176761ce2f6597013678b4538c772ae507400/apps/server/src/provider/Drivers/ClaudeMaintenance.ts#L27-L45
        ownsCommandPath: (normalized) => normalized.endsWith('/.local/bin/claude.exe')
          || normalized.includes('/.local/share/claude/')
          || normalized.includes('/claude/versions/'),
        args: ['update'],
      },
    },
    target: async () => ({ command: config.binary(), bundled: false }),
    environment: () => {
      const configHomeDir = config.configHomeDir();
      return installerEnvironment(CLAUDE_CREDENTIAL_KEYS, configHomeDir ? { CLAUDE_CONFIG_DIR: configHomeDir } : {});
    },
    nativeRelease: async () => {
      const url = `${CLAUDE_RELEASES_URL}/${await readClaudeReleaseChannel(config)}`;
      return { key: url, lookup: channelLatestVersion(url, (body) => body.trim()) };
    },
    onUpdated: () => options.versionProbe.invalidate(),
    logger: options.logger,
  });
}

// `claude update` installs from the `autoUpdatesChannel` setting, `latest` by default.
export async function readClaudeReleaseChannel(
  config: Pick<ClaudeConfig, 'configHomeDir'>,
  managedSettingsPath: string | undefined = MANAGED_SETTINGS_PATHS[process.platform],
): Promise<'latest' | 'stable'> {
  const userSettings = path.join(claudeConfigHomeDir({ configHomeDir: config.configHomeDir() ?? undefined }), 'settings.json');
  let channel: 'latest' | 'stable' = 'latest';
  for (const settingsPath of [userSettings, managedSettingsPath]) {
    if (!settingsPath) continue;
    const configured = await readChannelSetting(settingsPath);
    if (configured) channel = configured;
  }
  return channel;
}

async function readChannelSetting(settingsPath: string): Promise<'latest' | 'stable' | null> {
  try {
    const settings: unknown = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    const channel = isRecord(settings) ? settings.autoUpdatesChannel : undefined;
    return channel === 'latest' || channel === 'stable' ? channel : null;
  } catch {
    return null;
  }
}
