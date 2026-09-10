import { mock } from 'bun:test';
import { appendFileSync } from 'node:fs';
import { createLocalWorkspaceGitService } from '../../server/execution-node/local-workspace-git.js';

const observationPath = process.env.GARCON_TEST_GIT_TIMEOUT_OBSERVATION;
if (!observationPath) throw new Error('Workspace Git timeout fixture requires an observation path');
const createOwner = createLocalWorkspaceGitService;

mock.module('../../server/execution-node/local-workspace-git.js', () => ({
  createLocalWorkspaceGitService(options: Parameters<typeof createOwner>[0]) {
    appendFileSync(observationPath, JSON.stringify({ networkTimeoutMs: options.networkTimeoutMs }) + '\n');
    return createOwner(options);
  },
}));
