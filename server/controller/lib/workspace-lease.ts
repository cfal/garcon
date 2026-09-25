import { promises as fs } from 'node:fs';
import path from 'node:path';
import { executorDataDirectory } from '../../../common/cli-runtime-paths.js';
import { acquireWorkspaceLease, type WorkspaceLease, type WorkspaceLeaseOptions } from '../../common/workspace-lease.js';

export async function acquireControllerLease(
  configDir: string,
  workspaceDir: string,
  options: WorkspaceLeaseOptions = {},
): Promise<WorkspaceLease> {
  const configLease = await acquireWorkspaceLease(configDir, options);
  try {
    await fs.mkdir(workspaceDir, { recursive: true });
    const canonicalWorkspaceDir = await fs.realpath(workspaceDir);
    const workerDirectory = executorDataDirectory(configLease.workspaceDir);
    const canonicalWorkerDirectory = await fs.realpath(workerDirectory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return workerDirectory;
      throw error;
    });
    if (canonicalWorkspaceDir === canonicalWorkerDirectory || canonicalWorkspaceDir.startsWith(`${canonicalWorkerDirectory}${path.sep}`)) {
      throw new Error('The executor directory is reserved for worker storage; choose a different controller workspace');
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
