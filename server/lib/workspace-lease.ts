import { promises as fs } from 'fs';
import path from 'path';
import lockfile from 'proper-lockfile';
import { executionNodeDataDirectory } from '../../common/cli-runtime-paths.js';

export interface WorkspaceLease {
  workspaceDir: string;
  release(): Promise<void>;
}

export interface WorkspaceLeaseOptions {
  staleMs?: number;
  updateMs?: number;
  retries?: number;
  onCompromised?: (error: Error) => void;
}

export class WorkspaceInUseError extends Error {
  readonly code = 'WORKSPACE_IN_USE';

  constructor(public readonly workspaceDir: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Workspace is already in use or could not be locked: ${workspaceDir}. ${detail}`,
      { cause },
    );
    this.name = 'WorkspaceInUseError';
  }
}

export async function acquireControllerLease(
  configDir: string,
  workspaceDir: string,
  options: WorkspaceLeaseOptions = {},
): Promise<WorkspaceLease> {
  const configLease = await acquireWorkspaceLease(configDir, options);
  try {
    await fs.mkdir(workspaceDir, { recursive: true });
    const canonicalWorkspaceDir = await fs.realpath(workspaceDir);
    const workerDirectory = executionNodeDataDirectory(configLease.workspaceDir);
    const canonicalWorkerDirectory = await fs.realpath(workerDirectory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return workerDirectory;
      throw error;
    });
    if (canonicalWorkspaceDir === canonicalWorkerDirectory || canonicalWorkspaceDir.startsWith(`${canonicalWorkerDirectory}${path.sep}`)) {
      throw new Error('The execution-node directory is reserved for worker storage; choose a different controller workspace');
    }
    if (canonicalWorkspaceDir === configLease.workspaceDir) return configLease;
    const workspaceLease = await acquireWorkspaceLease(workspaceDir, options);
    return {
      workspaceDir: workspaceLease.workspaceDir,
      async release() {
        try { await workspaceLease.release(); }
        finally { await configLease.release(); }
      },
    };
  } catch (error) {
    await configLease.release();
    throw error;
  }
}

export async function acquireWorkspaceLease(
  workspaceDir: string,
  options: WorkspaceLeaseOptions = {},
): Promise<WorkspaceLease> {
  await fs.mkdir(workspaceDir, { recursive: true });
  const canonicalWorkspaceDir = await fs.realpath(workspaceDir);
  const lockPath = path.join(canonicalWorkspaceDir, '.garcon-workspace.lock');
  try {
    const releaseLock = await lockfile.lock(canonicalWorkspaceDir, {
      realpath: false,
      lockfilePath: lockPath,
      stale: options.staleMs ?? 30_000,
      update: options.updateMs ?? 5_000,
      retries: {
        retries: options.retries ?? 12,
        factor: 1.5,
        minTimeout: 250,
        maxTimeout: 5_000,
        randomize: true,
      },
      onCompromised: options.onCompromised ?? ((error) => {
        throw error;
      }),
    });
    let released = false;
    return {
      workspaceDir: canonicalWorkspaceDir,
      async release() {
        if (released) return;
        released = true;
        await releaseLock();
      },
    };
  } catch (error) {
    throw new WorkspaceInUseError(canonicalWorkspaceDir, error);
  }
}
