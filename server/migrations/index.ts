import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeJsonFileAtomic } from '../lib/json-file-store.js';

export const CURRENT_WORKSPACE_VERSION = 3;

const WORKSPACE_VERSION_FILE = 'workspace-version.json';
const FRESH_WORKSPACE_IGNORED_FILES = new Set([
  '.garcon-workspace.lock',
  WORKSPACE_VERSION_FILE,
]);

const MIGRATIONS = [
  { name: 'chat-id-migration', version: 1 },
  { name: 'core-record-migration', version: 2 },
  { name: 'ephemeral-queue-state-cleanup', version: 3 },
] as const;

export type WorkspaceMigrationName = typeof MIGRATIONS[number]['name'];

interface WorkspaceVersionFile {
  version: number;
}

export class WorkspaceMigrationRunner {
  readonly #workspaceDir: string;
  readonly #initialVersion: number;
  readonly #skipLadder: boolean;
  #nextEntry = 0;

  private constructor(workspaceDir: string, initialVersion: number, skipLadder: boolean) {
    this.#workspaceDir = workspaceDir;
    this.#initialVersion = initialVersion;
    this.#skipLadder = skipLadder;
  }

  static async open(workspaceDir: string): Promise<WorkspaceMigrationRunner> {
    const version = await readWorkspaceVersion(workspaceDir);
    if (version !== null) {
      if (version > CURRENT_WORKSPACE_VERSION) {
        throw new Error(
          `Workspace version ${version} is newer than supported version ${CURRENT_WORKSPACE_VERSION}`,
        );
      }
      return new WorkspaceMigrationRunner(workspaceDir, version, false);
    }

    const entries = await fs.readdir(workspaceDir);
    const fresh = entries.every((entry) => FRESH_WORKSPACE_IGNORED_FILES.has(entry));
    return new WorkspaceMigrationRunner(workspaceDir, 0, fresh);
  }

  async run(name: WorkspaceMigrationName, migrate: () => Promise<void>): Promise<void> {
    const entry = MIGRATIONS[this.#nextEntry];
    if (!entry || entry.name !== name) {
      throw new Error(`Workspace migration order violation: expected ${entry?.name ?? 'completion'}, got ${name}`);
    }
    this.#nextEntry += 1;
    if (!this.#skipLadder && this.#initialVersion < entry.version) await migrate();
  }

  async finish(): Promise<void> {
    if (this.#nextEntry !== MIGRATIONS.length) {
      throw new Error(`Workspace migration ladder stopped before ${MIGRATIONS[this.#nextEntry].name}`);
    }
    if (this.#initialVersion === CURRENT_WORKSPACE_VERSION) return;
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

async function readWorkspaceVersion(workspaceDir: string): Promise<number | null> {
  const filePath = path.join(workspaceDir, WORKSPACE_VERSION_FILE);
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Could not read ${WORKSPACE_VERSION_FILE}`, { cause: error });
  }
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || !Number.isSafeInteger((value as Record<string, unknown>).version)
    || Number((value as Record<string, unknown>).version) < 0
  ) {
    throw new Error(`${WORKSPACE_VERSION_FILE} must contain a nonnegative integer version`);
  }
  return Number((value as Record<string, unknown>).version);
}
