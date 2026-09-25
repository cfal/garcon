import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExecutionRuntime } from '../../runtime/execution-runtime.js';
import { RemoteExecutorClient } from '../client/executor-client.js';
import { ExecutorRpc } from '../transport/rpc.js';
import { serveExecutionRuntime } from '../server/executor-rpc-server.js';
import { WebSocketLink } from '../transport/websocket-link.js';
import { linkOptions } from './integration-fixture.js';
import { runGit } from '../../runtime/git/run.js';

export async function gitRpcFixture(dialer: 'controller' | 'worker' = 'controller') {
  const temporary = path.join(os.homedir(), 'tmp');
  await fs.mkdir(temporary, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporary, 'git-rpc-'));
  const projectPath = path.join(root, 'repo');
  await fs.mkdir(projectPath);
  await runGit(projectPath, ['init', '-b', 'main']);
  await runGit(projectPath, ['config', 'user.name', 'Synthetic Author']);
  await runGit(projectPath, ['config', 'user.email', 'test@example.invalid']);
  await fs.writeFile(path.join(projectPath, 'example.txt'), 'initial\n');
  await runGit(projectPath, ['add', '.']);
  await runGit(projectPath, ['commit', '-m', 'initial']);
  const local = new ExecutionRuntime({ id: linkOptions.executorId, workspaceDir: root, projectBasePath: root, integrations: [], resolveCredential: async () => null });
  const controller = new WebSocketLink({ ...linkOptions, role: 'controller' });
  const worker = new WebSocketLink({ ...linkOptions, role: 'worker' });
  let serving: ReturnType<typeof serveExecutionRuntime> | undefined;
  worker.onSession(transport => { serving = serveExecutionRuntime(local, new ExecutorRpc(transport)); });
  const connecting = RemoteExecutorClient.connect(controller);
  if (dialer === 'controller') controller.dial(worker.listen());
  else worker.dial(controller.listen());
  const executor = await connecting;
  return {
    root, projectPath, local, executor, controller, worker,
    async dispose() {
      await controller.dispose(); await worker.dispose(); await serving?.dispose(); await local.dispose();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
