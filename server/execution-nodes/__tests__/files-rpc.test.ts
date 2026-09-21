import { expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InProcessExecutionNode } from '../in-process.js';
import { RemoteExecutionNode } from '../remote.js';
import { AgentRpc } from '../rpc.js';
import { serveAgentNode } from '../agent-worker.js';
import { WebSocketLink } from '../websocket-link.js';
import { linkOptions } from './integration-fixture.js';

for (const dialer of ['controller', 'worker'] as const) {
  test(`file reads and saves above the Noise message limit with ${dialer} dialing`, async () => {
    const temporary = path.join(os.homedir(), 'tmp');
    await fs.mkdir(temporary, { recursive: true });
    const directory = await fs.mkdtemp(path.join(temporary, 'garcon-files-rpc-'));
    const local = new InProcessExecutionNode({ id: linkOptions.nodeId, workspaceDir: directory, projectBasePath: directory, integrations: [], resolveCredential: async () => null });
    const controller = new WebSocketLink({ ...linkOptions, role: 'controller' });
    const worker = new WebSocketLink({ ...linkOptions, role: 'worker' });
    let serving: ReturnType<typeof serveAgentNode> | undefined;
    worker.onSession((transport) => { serving = serveAgentNode(local, new AgentRpc(transport)); });
    const connecting = RemoteExecutionNode.connect(controller);
    if (dialer === 'controller') controller.dial(worker.listen());
    else worker.dial(controller.listen());
    try {
      const node = await connecting;
      const files = await node.getFilesService();
      const target = { projectPath: directory, filePath: 'example.txt' };
      const content = 'synthetic content\n'.repeat(1024 * 1024);
      await fs.writeFile(path.join(directory, target.filePath), content);
      const result = await files.read(target);
      expect(Buffer.from(result.bytes).toString()).toBe(content);
      const saved = await files.save({ ...target, content: `${content}end`, expectedRevision: result.revision, conflictResolution: 'reject' });
      expect((await files.revision(target))).toEqual({ status: 'ready', revision: saved.revision });
      await expect(files.save({ ...target, content: 'wrong', expectedRevision: result.revision, conflictResolution: 'reject' })).rejects.toMatchObject({ code: 'FILE_REVISION_CONFLICT', status: 409 });
      await expect(files.read({ ...target, filePath: 'missing' })).rejects.toMatchObject({ code: 'FILE_NOT_FOUND', status: 404 });
      expect(await fs.readFile(path.join(directory, target.filePath), 'utf8')).toBe(`${content}end`);
      expect((await files.identity(target)).nodeId).toBe(node.id);
      expect(node.availability).toBe('ready');
    } finally {
      await controller.dispose(); await worker.dispose(); await serving?.dispose(); await local.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
}
