import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isRecord } from '../../../common/json.js';
import { writeJsonFileAtomic } from '../../common/json-file-store.js';
import { parseStoredJson } from '../../common/stored-json.js';

export const CURRENT_WORKSPACE_VERSION = 11;

const WORKSPACE_VERSION_FILE = 'workspace-version.json';
const FRESH_WORKSPACE_IGNORED_FILES = new Set([
  '.garcon-workspace.lock',
  WORKSPACE_VERSION_FILE,
]);

const MIGRATIONS = [
  { name: 'chat-id-migration', version: 1 },
  { name: 'core-record-migration', version: 2 },
  { name: 'ephemeral-queue-state-cleanup', version: 3 },
  { name: 'carryover-node-migration', version: 4 },
  { name: 'carryover-segment-migration', version: 5 },
  { name: 'agent-integration-settings-refresh', version: 6 },
  { name: 'agent-execution-mode-refresh', version: 7 },
  { name: 'fork-ordinal-cleanup', version: 8 },
  { name: 'provider-assignments', version: 9 },
  { name: 'chat-relationships-split', version: 10 },
  { name: 'native-child-observers', version: 11 },
] as const;

export type WorkspaceMigrationName = typeof MIGRATIONS[number]['name'];

interface WorkspaceVersionFile {
  version: number;
  checkpoint?: true;
}

export class WorkspaceMigrationRunner {
  readonly #workspaceDir: string;
  readonly #initialVersion: number;
  readonly #skipLadder: boolean;
  readonly resumedFromCheckpoint: boolean;
  #nextEntry = 0;
  #checkpointVersion: number;

  private constructor(workspaceDir: string, stamp: WorkspaceVersionFile, skipLadder: boolean) {
    this.#workspaceDir = workspaceDir;
    this.#initialVersion = stamp.version;
    this.#skipLadder = skipLadder;
    this.#checkpointVersion = stamp.version;
    this.resumedFromCheckpoint = stamp.checkpoint === true;
  }

  get initialVersion(): number {
    return this.#initialVersion;
  }

  get isFresh(): boolean { return this.#skipLadder; }

  static async open(workspaceDir: string): Promise<WorkspaceMigrationRunner> {
    const stamp = await readWorkspaceVersion(workspaceDir);
    if (stamp !== null) {
      if (stamp.version > CURRENT_WORKSPACE_VERSION) {
        throw new Error(
          `Workspace version ${stamp.version} is newer than supported version ${CURRENT_WORKSPACE_VERSION}`,
        );
      }
      return new WorkspaceMigrationRunner(workspaceDir, stamp, false);
    }

    const entries = await fs.readdir(workspaceDir);
    const fresh = entries.every((entry) => FRESH_WORKSPACE_IGNORED_FILES.has(entry));
    return new WorkspaceMigrationRunner(workspaceDir, { version: 0 }, fresh);
  }

  async run(name: WorkspaceMigrationName, migrate: () => Promise<void>): Promise<void> {
    const entry = MIGRATIONS[this.#nextEntry];
    if (!entry || entry.name !== name) {
      throw new Error(`Workspace migration order violation: expected ${entry?.name ?? 'completion'}, got ${name}`);
    }
    if (!this.#skipLadder && this.#initialVersion < entry.version) await migrate();
    this.#nextEntry += 1;
  }

  async checkpointThrough(name: WorkspaceMigrationName): Promise<void> {
    const index = MIGRATIONS.findIndex((entry) => entry.name === name);
    if (index < 0 || index >= this.#nextEntry) {
      throw new Error(`Cannot checkpoint incomplete workspace migration ${name}`);
    }
    const { version } = MIGRATIONS[index];
    if (version <= this.#checkpointVersion) return;
    // Later schema writes must not be replayed through this completed prefix.
    await writeJsonFileAtomic(path.join(this.#workspaceDir, WORKSPACE_VERSION_FILE), {
      version,
      checkpoint: true,
    } satisfies WorkspaceVersionFile);
    this.#checkpointVersion = version;
  }

  async finish(): Promise<void> {
    if (this.#nextEntry !== MIGRATIONS.length) {
      throw new Error(`Workspace migration ladder stopped before ${MIGRATIONS[this.#nextEntry].name}`);
    }
    if (this.#initialVersion === CURRENT_WORKSPACE_VERSION && !this.resumedFromCheckpoint) return;
    await writeJsonFileAtomic(path.join(this.#workspaceDir, WORKSPACE_VERSION_FILE), {
      version: CURRENT_WORKSPACE_VERSION,
    } satisfies WorkspaceVersionFile);
  }
}

export async function cleanupLegacyQueueState(options: {
  workspaceDir: string;
  settleOwnershipIntents(): Promise<void>;
}): Promise<void> {
  await options.settleOwnershipIntents();
  await fs.rm(path.join(options.workspaceDir, 'queues'), { recursive: true, force: true });
  await Promise.all([
    'pending-user-inputs.json',
    'command-ledger.json',
  ].map((file) => fs.rm(path.join(options.workspaceDir, file), { force: true })));
}

async function readWorkspaceVersion(workspaceDir: string): Promise<WorkspaceVersionFile | null> {
  const filePath = path.join(workspaceDir, WORKSPACE_VERSION_FILE);
  let value: unknown;
  try {
    value = parseStoredJson(await fs.readFile(filePath, 'utf8'), WORKSPACE_VERSION_FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Could not read ${WORKSPACE_VERSION_FILE}`, { cause: error });
  }
  if (
    !isRecord(value)
    || typeof value.version !== 'number'
    || !Number.isSafeInteger(value.version)
    || value.version < 0
  ) {
    throw new Error(`${WORKSPACE_VERSION_FILE} must contain a nonnegative integer version`);
  }
  if (value.checkpoint !== undefined && value.checkpoint !== true) {
    throw new Error(`${WORKSPACE_VERSION_FILE} checkpoint must be true when present`);
  }
  return { version: value.version, ...(value.checkpoint === true ? { checkpoint: true } : {}) };
}
