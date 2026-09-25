import { expect, test, spyOn } from 'bun:test';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExecutionRuntime } from '../../runtime/execution-runtime.js';
import { RemoteExecutorClient } from '../client/executor-client.js';
import { ExecutorRpc } from '../transport/rpc.js';
import { serveExecutionRuntime } from '../server/executor-rpc-server.js';
import { WebSocketLink } from '../transport/websocket-link.js';
import { linkOptions } from './integration-fixture.js';
import { decodeFileData, decodeFileText } from '../transport/file-protocol.js';
import { RemoteFilesService } from '../client/remote-files.js';
import { MAX_FILE_REVISION_LENGTH, MAX_FILE_VIEW_BYTES } from '../../../common/file-contracts.js';

test('inline file data rejects malformed encoding and oversized payloads', () => {
  for (const data of ['?', 'eA', null]) expect(() => decodeFileData(data)).toThrow(expect.objectContaining({ code: 'FILE_INVALID_DATA' }));
  expect(() => decodeFileText('/w==')).toThrow(expect.objectContaining({ code: 'FILE_INVALID_DATA' }));
  expect(() => decodeFileData(Buffer.alloc(MAX_FILE_VIEW_BYTES + 1).toString('base64'))).toThrow(expect.objectContaining({ code: 'FILE_TOO_LARGE' }));
  expect(decodeFileText('')).toBe('');
});

test.each([MAX_FILE_REVISION_LENGTH + 1, 17 * 1024 * 1024])('rejects a %d-character save revision before accessing the RPC session', async (length) => {
  let backingCalls = 0;
  const files = new RemoteFilesService(() => {
    backingCalls++;
    throw new Error('Save must not access the RPC session');
  });
  for (const conflictResolution of ['reject', 'overwrite'] as const) {
    await expect(files.save({
      projectPath: '/project', filePath: 'file.txt', content: 'x',
      expectedRevision: `v1:${'a'.repeat(length - 3)}`, conflictResolution,
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
  }
  expect(backingCalls).toBe(0);
});

for (const dialer of ['controller', 'worker'] as const) {
  test(`bounded inline file reads and saves with ${dialer} dialing`, async () => {
    const temporary = path.join(os.homedir(), 'tmp');
    await fs.mkdir(temporary, { recursive: true });
    const directory = await fs.mkdtemp(path.join(temporary, 'garcon-files-rpc-'));
    const local = new ExecutionRuntime({ id: linkOptions.executorId, workspaceDir: directory, projectBasePath: directory, integrations: [], resolveCredential: async () => null });
    const controller = new WebSocketLink({ ...linkOptions, role: 'controller' });
    const worker = new WebSocketLink({ ...linkOptions, role: 'worker' });
    let serving: ReturnType<typeof serveExecutionRuntime> | undefined;
    worker.onSession((transport) => { serving = serveExecutionRuntime(local, new ExecutorRpc(transport)); });
    const connecting = RemoteExecutorClient.connect(controller);
    if (dialer === 'controller') controller.dial(worker.listen());
    else worker.dial(controller.listen());
    try {
      const executor = await connecting;
      const files = await executor.getFilesService();
      const target = { projectPath: directory, filePath: 'example.txt' };
      const content = '\u001f'.repeat(MAX_FILE_VIEW_BYTES);
      await fs.writeFile(path.join(directory, target.filePath), content);
      const result = await files.read(target);
      expect(Buffer.from(result.bytes).toString()).toBe(content);
      const saved = await files.save({ ...target, content, expectedRevision: result.revision, conflictResolution: 'reject' });
      expect((await files.revision(target))).toEqual({ status: 'ready', revision: saved.revision });
      await expect(files.save({ ...target, content: 'wrong', expectedRevision: result.revision, conflictResolution: 'reject' })).rejects.toMatchObject({ code: 'FILE_REVISION_CONFLICT', status: 409 });
      await expect(files.read({ ...target, filePath: 'missing' })).rejects.toMatchObject({ code: 'FILE_NOT_FOUND', status: 404 });
      expect(await fs.readFile(path.join(directory, target.filePath), 'utf8')).toBe(content);
      await expect(files.save({ ...target, content: content + 'x', expectedRevision: saved.revision, conflictResolution: 'overwrite' })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE', status: 413 });
      await fs.writeFile(path.join(directory, target.filePath), content + 'x');
      await expect(files.read(target)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE', status: 413 });
      for (const text of ['', 'synthetic \u{1F642}', '\uFEFFsynthetic BOM']) {
        const updated = await files.save({ ...target, content: text, expectedRevision: saved.revision, conflictResolution: 'overwrite' });
        expect(Buffer.from((await files.read(target)).bytes).toString()).toBe(text);
        expect((await files.revision(target))).toEqual({ status: 'ready', revision: updated.revision });
      }
      expect((await files.identity(target)).executorId).toBe(executor.id);
      expect(executor.availability).toBe('ready');
    } finally {
      await controller.dispose(); await worker.dispose(); await serving?.dispose(); await local.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
}

for (const phase of ['before dispatch', 'after commit'] as const) {
  test(`file save failure ${phase} never blindly retries or reports success`, async () => {
    const directory = await fs.mkdtemp(path.join(os.homedir(), 'tmp', 'garcon-files-failure-'));
    const local = new ExecutionRuntime({ id: linkOptions.executorId, workspaceDir: directory, projectBasePath: directory, integrations: [], resolveCredential: async () => null });
    const controller = new WebSocketLink({ ...linkOptions, role: 'controller' });
    const worker = new WebSocketLink({ ...linkOptions, role: 'worker' });
    let serving: ReturnType<typeof serveExecutionRuntime> | undefined;
    worker.onSession((transport) => { serving = serveExecutionRuntime(local, new ExecutorRpc(transport)); });
    const connecting = RemoteExecutorClient.connect(controller);
    controller.dial(worker.listen());
    const service = await local.getFilesService();
    const save = service.save.bind(service);
    const saved = spyOn(service, 'save').mockImplementation(async (request, options) => {
      const result = await save(request, options);
      if (phase === 'after commit') await controller.dispose();
      return result;
    });
    try {
      const executor = await connecting;
      const files = await executor.getFilesService();
      const target = { projectPath: directory, filePath: 'file.txt' };
      await fs.writeFile(path.join(directory, target.filePath), 'original');
      const { revision } = await files.read(target);
      const content = 'replacement';
      if (phase === 'before dispatch') await controller.dispose();
      const result = files.save({ ...target, content, expectedRevision: revision, conflictResolution: 'reject' });
      if (phase === 'after commit') await expect(result).rejects.toMatchObject({ code: 'FILE_SAVE_OUTCOME_UNKNOWN' });
      else await expect(result).rejects.toThrow();
      expect(saved).toHaveBeenCalledTimes(phase === 'after commit' ? 1 : 0);
      expect(await fs.readFile(path.join(directory, target.filePath), 'utf8')).toBe(phase === 'after commit' ? content : 'original');
    } finally {
      saved.mockRestore();
      await controller.dispose();
      await worker.dispose();
      await serving?.dispose();
      await local.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
}
