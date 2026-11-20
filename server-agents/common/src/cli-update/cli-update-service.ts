import { promises as fs } from 'node:fs';
import {
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
import { runBoundedCommand, type BoundedCommandResult } from './bounded-command.js';
import { compareCliVersions, parseCliVersion } from './cli-version.js';
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

export interface CliUpdateServiceOptions {
  readonly label: string;
  readonly definition: CliInstallDefinition;
  readonly target: () => Promise<CliUpdateTarget>;
  readonly environment: () => Record<string, string>;
  // The release the native installer's own update command installs, which can lag npm.
  readonly nativeLatestVersion: { readonly key: string; readonly lookup: LatestVersionLookup };
  // Runs after an update command exits, so cached facts about the old binary are dropped.
  readonly onUpdated?: () => void;
  readonly logger: AgentLogger;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => Date;
}

type InstalledStatus = Omit<AgentCliUpdateStatus, 'run'>;

// `claude update` downloads about 300 MB without progress output, and killing
// it mid-download leaves a truncated binary, so the deadline is generous.
const UPDATE_TIMEOUT_MS = 30 * 60 * 1000;
const VERSION_PROBE_TIMEOUT_MS = 20_000;
const VERSION_PROBE_MAX_BYTES = 16 * 1024;
const PROGRESS_INTERVAL_MS = 1_000;
const PROGRESS_MAX_CHARS = 200;

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
  // Reported while a run is active, so a status read does not probe a binary mid-install.
  #lastStatus: InstalledStatus | null = null;

  constructor(options: CliUpdateServiceOptions) {
    this.#options = options;
  }

  async status(request: AgentCliUpdateStatusRequest): Promise<AgentCliUpdateStatus> {
    if (this.#run.state === 'running' && this.#lastStatus) return { ...this.#lastStatus, run: this.#run };
    const status = await this.#inspect(request.refresh, request.signal ?? new AbortController().signal);
    this.#lastStatus = status;
    return { ...status, run: this.#run };
  }

  async startUpdate(): Promise<AgentCliUpdateStatus> {
    if (this.#run.state !== 'running') {
      if (!this.#starting) {
        this.#starting = this.#begin().finally(() => { this.#starting = null; });
      }
      await this.#starting;
    }
    return this.status({ refresh: false });
  }

  async #begin(): Promise<void> {
    const env = this.#options.environment();
    const target = await this.#options.target();
    if (target.bundled) {
      throw new AgentIntegrationError(
        'OPERATION_UNSUPPORTED', `Garcon runs its bundled ${this.#options.label}, which updates with Garcon.`, false,
      );
    }
    const installation = await resolveCliInstallation(this.#options.definition, {
      command: target.command, env, platform: this.#platform,
    });
    const action = installation.update;
    if (!action) {
      throw new AgentIntegrationError('OPERATION_UNSUPPORTED', this.#manualUpdateMessage(installation, null), false);
    }
    this.#run = {
      state: 'running', startedAt: this.#timestamp(), finishedAt: null,
      message: 'Checking for the latest version', output: null,
    };
    this.#options.logger.info('CLI update started.', { command: action.command });
    void this.#execute(installation, action, env).catch((error: unknown) => {
      this.#finish('failed', error instanceof Error ? error.message : String(error), null);
    });
  }

  async #execute(installation: CliInstallation, action: CliUpdateAction, env: Record<string, string>): Promise<void> {
    const signal = new AbortController().signal;
    const executable = installation.paths!.resolved;
    const before = await this.#probeVersion(executable, env);
    const latest = await this.#latestVersion(installation, env, true, signal);
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
    const after = await this.#probeVersion(executable, env);
    if (!after) {
      this.#finish('unchanged', `The update command finished, but ${this.#options.label} did not report its version.`, output);
    } else if (latest ? (compareCliVersions(after, latest) ?? -1) < 0 : after === before) {
      this.#finish('unchanged', `The update command finished, but ${this.#options.label} still reports ${after}.`, output);
    } else {
      this.#finish('succeeded', `Updated ${this.#options.label} to ${after}.`, output);
    }
  }

  async #inspect(refresh: boolean, signal: AbortSignal): Promise<InstalledStatus> {
    const env = this.#options.environment();
    const target = await this.#options.target();
    const checkedAt = this.#timestamp();
    if (target.bundled) {
      return {
        installMethod: 'bundled',
        installPath: await fs.realpath(target.command).catch(() => target.command),
        currentVersion: await this.#probeVersion(target.command, env),
        latestVersion: null,
        advisory: 'unknown',
        updateCommand: null,
        canUpdate: false,
        message: `Garcon runs its bundled ${this.#options.label}, which updates with Garcon.`,
        checkedAt,
      };
    }
    const installation = await resolveCliInstallation(this.#options.definition, {
      command: target.command, env, platform: this.#platform,
    });
    signal.throwIfAborted();
    if (!installation.paths) {
      return {
        installMethod: 'missing', installPath: null, currentVersion: null, latestVersion: null, advisory: 'unknown',
        updateCommand: null, canUpdate: false, checkedAt,
        message: `${this.#options.label} (${target.command}) was not found on PATH.`,
      };
    }
    const currentVersion = await this.#probeVersion(installation.paths.resolved, env);
    const latestVersion = currentVersion ? await this.#latestVersion(installation, env, refresh, signal) : null;
    const order = currentVersion && latestVersion ? compareCliVersions(currentVersion, latestVersion) : null;
    const advisory = order === null ? 'unknown' : order < 0 ? 'behind-latest' : 'current';
    return {
      installMethod: installation.method,
      installPath: installation.paths.real,
      currentVersion,
      latestVersion,
      advisory,
      updateCommand: installation.update?.command ?? installation.manualCommand,
      canUpdate: installation.update !== null,
      message: currentVersion === null
        ? `${this.#options.label} at ${installation.paths.real} did not report its version.`
        : advisory === 'behind-latest' && installation.update === null
          ? this.#manualUpdateMessage(installation, latestVersion)
          : null,
      checkedAt,
    };
  }

  #latestVersion(
    installation: CliInstallation,
    env: Record<string, string>,
    fresh: boolean,
    signal: AbortSignal,
  ): Promise<string | null> {
    const source = installation.latestVersion;
    const packageName = this.#options.definition.packageName;
    if (source.kind === 'native') {
      return this.#latestVersions.get(this.#options.nativeLatestVersion.key, this.#options.nativeLatestVersion.lookup, { fresh, signal });
    }
    if (source.kind === 'homebrew') {
      return this.#latestVersions.get(`homebrew:${source.cask ? 'cask' : 'formula'}:${source.name}`, homebrewLatestVersion(source, env), { fresh, signal });
    }
    return this.#latestVersions.get(`npm:${packageName}`, npmLatestVersion(packageName, env), { fresh, signal });
  }

  async #probeVersion(executable: string, env: Record<string, string>): Promise<string | null> {
    try {
      const result = await runBoundedCommand([executable, '--version'], {
        env, timeoutMs: VERSION_PROBE_TIMEOUT_MS, maxOutputBytes: VERSION_PROBE_MAX_BYTES,
      });
      // A failed run's output can belong to a wrapper rather than the CLI.
      return result.exitCode === 0 ? parseCliVersion(`${result.stdout}\n${result.stderr}`) : null;
    } catch {
      return null;
    }
  }

  #manualUpdateMessage(installation: CliInstallation, latestVersion: string | null): string {
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
      this.#progress(line.length > PROGRESS_MAX_CHARS ? `${line.slice(0, PROGRESS_MAX_CHARS - 1)}…` : line);
    };
  }

  #progress(message: string): void {
    if (this.#run.state === 'running') this.#run = { ...this.#run, message };
  }

  #finish(state: 'succeeded' | 'failed' | 'unchanged', message: string, output: string | null): void {
    this.#run = {
      state, startedAt: this.#run.startedAt, finishedAt: this.#timestamp(), message,
      output: output ? output.slice(-AGENT_CLI_UPDATE_OUTPUT_MAX_CHARS) : null,
    };
    this.#lastStatus = null;
    const log = state === 'failed' ? this.#options.logger.warn : this.#options.logger.info;
    log.call(this.#options.logger, 'CLI update finished.', { state, message });
  }

  get #platform(): NodeJS.Platform {
    return this.#options.platform ?? process.platform;
  }

  #timestamp(): string {
    return (this.#options.now?.() ?? new Date()).toISOString();
  }
}

function combinedOutput(result: BoundedCommandResult): string | null {
  return [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n\n') || null;
}

// Prefers the last line naming an error or failure; `claude update` ends a
// failure with an unrelated hint to run `claude doctor`.
function failureReason(result: BoundedCommandResult): string {
  const lines = [result.stderr, result.stdout]
    .map((text) => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  for (const streamLines of lines) {
    const match = streamLines.findLast((line) => /error|fail/i.test(line));
    if (match) return match;
  }
  return lines[0]!.at(-1) ?? lines[1]!.at(-1) ?? 'no output';
}
