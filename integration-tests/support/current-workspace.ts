import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CURRENT_WORKSPACE_VERSION } from '../../server/controller/migrations/index.js';
import type { ApiProviderAssignments } from '../../common/api-providers.js';

export async function seedCurrentWorkspace(workspace: string): Promise<void> {
  await writeFile(join(workspace, 'api-provider-assignments.json'), JSON.stringify({
    version: 1,
    revision: 0,
    assignments: {},
  } satisfies ApiProviderAssignments & { version: 1 }), { flag: 'wx', mode: 0o600 });
  await writeFile(join(workspace, 'workspace-version.json'), JSON.stringify({
    version: CURRENT_WORKSPACE_VERSION,
  }));
}
