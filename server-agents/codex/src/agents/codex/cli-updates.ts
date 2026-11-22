import type { AgentLogger } from '@garcon/server-agent-interface';
import { CliUpdateService } from '@garcon/server-agent-common/cli-update/cli-update-service';
import { channelLatestVersion } from '@garcon/server-agent-common/cli-update/latest-version';
import type { CodexConfig } from '../../config.js';
import { resolveCodexCli } from './app-server/cli.js';
import { installerEnvironment } from '@garcon/server-agent-common/cli-update/installer-environment';

// `codex update` installs this channel's release, which can lag npm's latest tag.
// https://github.com/pingdotgg/t3code/blob/be9176761ce2f6597013678b4538c772ae507400/apps/server/src/provider/Drivers/CodexDriver.ts#L105-L128
const CODEX_NATIVE_CHANNEL = 'https://releases.openai.com/codex/channels/latest';
const STANDALONE_HOME_PATTERN = /^(.*)\/packages\/standalone\//is;
const CODEX_CREDENTIAL_KEYS = ['OPENAI_API_KEY', 'CODEX_API_KEY'];

// The standalone installer keeps its executables under `<CODEX_HOME>/packages/standalone/`.
export function codexStandaloneHome(commandPath: string): string | null {
  const match = STANDALONE_HOME_PATTERN.exec(commandPath.replaceAll('\\', '/'));
  if (!match) return null;
  const home = match[1]!;
  const isRoot = home === '' || /^[a-z]:$/i.test(home);
  return commandPath.slice(0, home.length + (isRoot ? 1 : 0));
}

export function parseCodexChannelRelease(body: string): string | null {
  try {
    const tag: unknown = (JSON.parse(body) as { tag_name?: unknown }).tag_name;
    return typeof tag === 'string' ? /^rust-v(\d+\.\d+\.\d+)$/.exec(tag)?.[1] ?? null : null;
  } catch {
    return null;
  }
}

export function createCodexCliUpdates(options: {
  readonly config: CodexConfig;
  readonly logger: AgentLogger;
}): CliUpdateService {
  const { config } = options;
  return new CliUpdateService({
    label: 'Codex CLI',
    definition: {
      packageName: '@openai/codex',
      native: {
        ownsCommandPath: (normalized) => codexStandaloneHome(normalized) !== null,
        args: ['update'],
        // `codex update` must see the home that owns the standalone install,
        // not the CODEX_HOME Garcon gives its sessions.
        env: (paths) => ({
          CODEX_HOME: codexStandaloneHome(paths.real) ?? codexStandaloneHome(paths.resolved) ?? config.home(),
        }),
      },
    },
    // The pinned app-server binary that Garcon ships wins over PATH unless
    // GARCON_CODEX_CLI selects another one.
    target: async () => {
      const resolved = await resolveCodexCli();
      return { command: resolved.command, bundled: resolved.source === 'bundled' };
    },
    environment: () => installerEnvironment(CODEX_CREDENTIAL_KEYS, { CODEX_HOME: config.home() }),
    nativeRelease: async () => ({
      key: CODEX_NATIVE_CHANNEL,
      lookup: channelLatestVersion(CODEX_NATIVE_CHANNEL, parseCodexChannelRelease),
    }),
    logger: options.logger,
  });
}
