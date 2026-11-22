import { promises as fs } from 'node:fs';
import {
  AGENT_CLI_UPDATE_MESSAGE_MAX_CHARS,
  AGENT_CLI_UPDATE_OUTPUT_MAX_CHARS,
  IDLE_AGENT_CLI_UPDATE_RUN,
  type AgentCliUpdateRun,
  type AgentCliUpdateStatus,
} from '@garcon/common/agent-cli-update';
import {
  AgentIntegrationError,
  type AgentCliUpdates,
  type AgentCliUpdateStatusRequest,
  type AgentLogger,
} from '@garcon/server-agent-interface';
import { outputLines, runBoundedCommand, type BoundedCommandResult } from './bounded-command.js';
import { probeCliVersion } from './cli-probe.js';
import { compareCliVersions } from './cli-version.js';
import { errorMessage } from '../lib/errors.js';
import {
  resolveCliInstallation,
  type CliInstallation,
  type CliInstallDefinition,
  type CliUpdateAction,
} from './install-resolution.js';
import {
  homebrewLatestVersion,
  LatestVersionCache,
  npmLatestVersion,
  type LatestVersionLookup,
} from './latest-version.js';

export interface CliUpdateTarget {
  readonly command: string;
  // Garcon ships this executable and replaces it only with a Garcon release.
  readonly bundled: boolean;
}

// The release a native installer's own update command installs, which can lag
// npm. The key identifies the release channel, so a channel change misses the cache.
export interface NativeReleaseSource {
  readonly key: string;
  readonly lookup: LatestVersionLookup;
}

export interface CliUpdateServiceOptions {
  readonly label: string;
  readonly definition: CliInstallDefinition;
  readonly target: () => Promise<CliUpdateTarget>;
  readonly environment: () => Record<string, string>;
  readonly nativeRelease: () => Promise<NativeReleaseSource>;
  // Runs after an update command exits, so cached facts about the old binary are dropped.
  readonly onUpdated?: () => void;
  readonly logger: AgentLogger;
  readonly now?: () => Date;
}

type InstalledStatus = Omit<AgentCliUpdateStatus, 'cliLabel' | 'run'>;

// `claude update` downloads about 300 MB without progress output, and killing
// it mid-download leaves a truncated binary, so the deadline is generous.
const UPDATE_TIMEOUT_MS = 30 * 60 * 1000;
const VERSION_PROBE_TIMEOUT_MS = 20_000;
const PROGRESS_INTERVAL_MS = 1_000;

// Installers are process-wide: two integrations installed by the same npm
// prefix or Homebrew must not run their installers at once.
const installerLocks = new Map<string, Promise<void>>();

async function withInstallerLock<T>(key: string, onWait: () => void, run: () => Promise<T>): Promise<T> {
  const previous = installerLocks.get(key);
  const released = Promise.withResolvers<void>();
  const current = (previous ?? Promise.resolve()).then(() => released.promise);
  installerLocks.set(key, current);
  if (previous) {
    onWait();
    await previous;
  }
  try {
    return await run();
  } finally {
    released.resolve();
    if (installerLocks.get(key) === current) installerLocks.delete(key);
  }
}

export class CliUpdateService implements AgentCliUpdates {
  readonly #options: CliUpdateServiceOptions;
  readonly #latestVersions = new LatestVersionCache();
  #run: AgentCliUpdateRun = IDLE_AGENT_CLI_UPDATE_RUN;
  #starting: Promise<void> | null = null;
  // Taken when a run starts and reported until it finishes, so a status read
  // does not probe a binary mid-install.
  #runSnapshot: InstalledStatus | null = null;
  // Shared by concurrent status reads, so each does not probe the binary again.
  #inspection: Promise<InstalledStatus> | null = null;

  constructor(options: CliUpdateServiceOptions) {
    this.#options = options;
  }

  async status(request: AgentCliUpdateStatusRequest): Promise<AgentCliUpdateStatus> {
    const cliLabel = this.#options.label;
    if (this.#runSnapshot) return { cliLabel, ...this.#runSnapshot, run: this.#run };
    if (request.refresh || !this.#inspection) {
      const inspection = this.#inspect(request.refresh).finally(() => {
        if (this.#inspection === inspection) this.#inspection = null;
      });
      this.#inspection = inspection;
    }
    const status = await this.#inspection;
    request.signal?.throwIfAborted();
    return { cliLabel, ...(this.#runSnapshot ?? status), run: this.#run };
  }

  async startUpdate(): Promise<AgentCliUpdateStatus> {
    if (this.#run.state !== 'running') {
      this.#starting ??= this.#begin().finally(() => { this.#starting = null; });
      await this.#starting;
    }
    return this.status({ refresh: false });
  }

  async #begin(): Promise<void> {
    const env = this.#options.environment();
    const { installation } = await this.#resolve(env);
    const action = installation.update;
    if (!action) throw new AgentIntegrationError('OPERATION_UNSUPPORTED', this.#manualMessage(installation, null), false);
    // The run installs the latest release, so the check that starts it bypasses the cache.
    const snapshot = await this.#inspectInstallation(installation, env, true);
    this.#runSnapshot = snapshot;
    this.#inspection = null;
    this.#run = {
      state: 'running', startedAt: this.#timestamp(), finishedAt: null,
      message: 'Checking for the latest version', output: null,
    };
    this.#options.logger.info('CLI update started.', { command: action.command });
    void this.#execute(installation, action, env, snapshot).catch((error: unknown) => {
      this.#finish('failed', errorMessage(error), null);
    });
  }

  async #execute(
    installation: CliInstallation,
    action: CliUpdateAction,
    env: Record<string, string>,
    { currentVersion: before, latestVersion: latest }: InstalledStatus,
  ): Promise<void> {
    if (before && latest && (compareCliVersions(before, latest) ?? -1) >= 0) {
      this.#finish('succeeded', `${this.#options.label} ${before} is already the latest version.`, null);
      return;
    }
    const result = await withInstallerLock(
      action.lockKey,
      () => this.#progress('Waiting for another update to finish'),
      () => {
        this.#progress(`Running ${action.command}`);
        return runBoundedCommand([action.executable, ...action.args], {
          env: { ...env, ...action.env },
          timeoutMs: UPDATE_TIMEOUT_MS,
          maxOutputBytes: AGENT_CLI_UPDATE_OUTPUT_MAX_CHARS,
          onLine: this.#throttledProgress(),
        });
      },
    );
    this.#latestVersions.clear();
    this.#options.onUpdated?.();
    const output = combinedOutput(result);
    if (result.timedOut) {
      this.#finish('failed', 'The update timed out after 30 minutes.', output);
      return;
    }
    if (result.exitCode !== 0) {
      this.#finish('failed', `The update command exited with code ${result.exitCode}: ${failureReason(result)}`, output);
      return;
    }
    this.#progress('Verifying the installed version');
    const after = await probeCliVersion(installation.paths!.resolved, env, VERSION_PROBE_TIMEOUT_MS);
    if (!after) {
      this.#finish('unchanged', `The update command finished, but ${this.#options.label} did not report its version.`, output);
    } else if (latest ? (compareCliVersions(after, latest) ?? -1) < 0 : after === before) {
      this.#finish('unchanged', `The update command finished, but ${this.#options.label} still reports ${after}.`, output);
    } else {
      this.#finish(
        'succeeded',
        `Updated ${this.#options.label} to ${after}. Running chats keep the previous version; new sessions use the update.`,
        output,
      );
    }
  }

  async #inspect(refresh: boolean): Promise<InstalledStatus> {
    const env = this.#options.environment();
    const { target, installation } = await this.#resolve(env);
    if (!installation.paths) {
      return {
        installMethod: 'missing', installPath: null, currentVersion: null, latestVersion: null, advisory: 'unknown',
        updateCommand: null, canUpdate: false, checkedAt: this.#timestamp(),
        message: `${this.#options.label} (${target.command}) was not found on PATH.`,
      };
    }
    return this.#inspectInstallation(installation, env, refresh);
  }

  async #inspectInstallation(installation: CliInstallation, env: Record<string, string>, refresh: boolean): Promise<InstalledStatus> {
    const paths = installation.paths!;
    // The lookup is cached, so starting it before the probe settles costs nothing when the probe fails.
    const [currentVersion, latest] = await Promise.all([
      probeCliVersion(paths.resolved, env, VERSION_PROBE_TIMEOUT_MS),
      this.#latestVersion(installation, env, refresh),
    ]);
    const latestVersion = currentVersion ? latest : null;
    const order = currentVersion && latestVersion ? compareCliVersions(currentVersion, latestVersion) : null;
    const advisory = order === null ? 'unknown' : order < 0 ? 'behind-latest' : 'current';
    return {
      installMethod: installation.method,
      installPath: paths.real,
      currentVersion,
      latestVersion,
      advisory,
      updateCommand: installation.update?.command ?? installation.manualCommand,
      canUpdate: installation.update !== null,
      message: installation.method === 'bundled'
        ? this.#manualMessage(installation, null)
        : currentVersion === null
          ? `${this.#options.label} at ${paths.real} did not report its version.`
          : advisory === 'behind-latest' && installation.update === null
            ? this.#manualMessage(installation, latestVersion)
            : null,
      checkedAt: this.#timestamp(),
    };
  }

  // Garcon's bundled executable is reported like an installation it cannot update.
  async #resolve(env: Record<string, string>): Promise<{ target: CliUpdateTarget; installation: CliInstallation }> {
    const target = await this.#options.target();
    if (!target.bundled) {
      const installation = await resolveCliInstallation(this.#options.definition, {
        command: target.command, env, platform: process.platform,
      });
      return { target, installation };
    }
    const real = await fs.realpath(target.command).catch(() => target.command);
    return {
      target,
      installation: {
        method: 'bundled', paths: { resolved: target.command, real }, update: null, manualCommand: null,
        latestVersion: { kind: 'none' },
      },
    };
  }

  async #latestVersion(installation: CliInstallation, env: Record<string, string>, fresh: boolean): Promise<string | null> {
    const source = installation.latestVersion;
    switch (source.kind) {
      case 'none': return null;
      case 'native': {
        const release = await this.#options.nativeRelease();
        return this.#latestVersions.get(release.key, release.lookup, { fresh });
      }
      case 'homebrew':
        return this.#latestVersions.get(`homebrew:${source.cask ? 'cask' : 'formula'}:${source.name}`, homebrewLatestVersion(source, env), { fresh });
      case 'npm': {
        const packageName = this.#options.definition.packageName;
        return this.#latestVersions.get(`npm:${packageName}`, npmLatestVersion(packageName, env), { fresh });
      }
    }
  }

  // Explains why Garcon does not update this installation in place.
  #manualMessage(installation: CliInstallation, latestVersion: string | null): string {
    if (installation.method === 'bundled') return `Garcon runs its bundled ${this.#options.label}, which updates with Garcon.`;
    const path = installation.paths?.real;
    const subject = latestVersion ? `Version ${latestVersion} is out. ` : '';
    const location = path ? `Garcon runs ${path}; update` : 'Update';
    const command = installation.manualCommand ? ` with: ${installation.manualCommand}` : ' with the tool that installed it.';
    return `${subject}${location} it${command}`;
  }

  #throttledProgress(): (line: string) => void {
    let lastPublishedAt = 0;
    return (line) => {
      const now = Date.now();
      if (now - lastPublishedAt < PROGRESS_INTERVAL_MS) return;
      lastPublishedAt = now;
      this.#progress(line);
    };
  }

  #progress(message: string): void {
    if (this.#run.state === 'running') this.#run = { ...this.#run, message: truncate(message) };
  }

  #finish(state: 'succeeded' | 'failed' | 'unchanged', message: string, output: string | null): void {
    this.#run = {
      state, startedAt: this.#run.startedAt, finishedAt: this.#timestamp(), message: truncate(message),
      output: output ? output.slice(-AGENT_CLI_UPDATE_OUTPUT_MAX_CHARS) : null,
    };
    this.#runSnapshot = null;
    // An inspection started during the run must not report the old binary.
    this.#inspection = null;
    const log = state === 'failed' ? this.#options.logger.warn : this.#options.logger.info;
    log.call(this.#options.logger, 'CLI update finished.', { state, message: this.#run.message });
  }

  #timestamp(): string {
    return (this.#options.now?.() ?? new Date()).toISOString();
  }
}

function truncate(message: string): string {
  return message.length > AGENT_CLI_UPDATE_MESSAGE_MAX_CHARS
    ? `${message.slice(0, AGENT_CLI_UPDATE_MESSAGE_MAX_CHARS - 1)}…`
    : message;
}

// Puts stderr last, so trimming the combined output to its budget drops stdout first.
function combinedOutput(result: BoundedCommandResult): string | null {
  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n\n') || null;
}

// Prefers the last line naming an error or failure; `claude update` ends a
// failure with an unrelated hint to run `claude doctor`.
function failureReason(result: BoundedCommandResult): string {
  const stderr = outputLines(result.stderr);
  const stdout = outputLines(result.stdout);
  const reason = stderr.findLast((line) => /error|fail/i.test(line))
    ?? stdout.findLast((line) => /error|fail/i.test(line))
    ?? stderr.at(-1)
    ?? stdout.at(-1)
    ?? 'no output';
  return truncate(reason);
}
