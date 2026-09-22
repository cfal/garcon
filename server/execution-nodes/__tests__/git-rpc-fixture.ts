import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InProcessExecutionNode } from '../in-process.js';
import { RemoteExecutionNode } from '../remote.js';
import { AgentRpc } from '../rpc.js';
import { serveAgentNode } from '../agent-worker.js';
import { WebSocketLink } from '../websocket-link.js';
import { linkOptions } from './integration-fixture.js';
import { runGit } from '../../git/run.js';

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
  const local = new InProcessExecutionNode({ id: linkOptions.nodeId, workspaceDir: root, projectBasePath: root, integrations: [], resolveCredential: async () => null });
  const controller = new WebSocketLink({ ...linkOptions, role: 'controller' });
  const worker = new WebSocketLink({ ...linkOptions, role: 'worker' });
  let serving: ReturnType<typeof serveAgentNode> | undefined;
  worker.onSession(transport => { serving = serveAgentNode(local, new AgentRpc(transport)); });
  const connecting = RemoteExecutionNode.connect(controller);
  if (dialer === 'controller') controller.dial(worker.listen());
  else worker.dial(controller.listen());
  const node = await connecting;
  return {
    root, projectPath, local, node, controller, worker,
    async dispose() {
      await controller.dispose(); await worker.dispose(); await serving?.dispose(); await local.dispose();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
