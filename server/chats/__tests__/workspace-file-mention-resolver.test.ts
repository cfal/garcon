import { expect, mock, test } from 'bun:test';
import type { WorkspaceFileMentionService } from '../../execution-nodes/workspace-file-mentions.js';
import type { FileMentionTarget } from '../file-mentions.js';
import { WorkspaceFileMentionResolver } from '../workspace-file-mention-resolver.js';

const target: FileMentionTarget = {
  agentId: 'synthetic', projectPath: '/synthetic/project',
  executionLocation: { nodeId: 'node', instanceId: 'instance', workspaceId: 'workspace' },
};

test.each(['plain command', 'email@synthetic.invalid', 'trailing @', 'unclosed @"quote'])(
  'does not resolve a workspace without a file token: %s', async (command) => {
    const serviceFor = mock((): WorkspaceFileMentionService => { throw new Error('Unexpected workspace lookup'); });
    expect(await new WorkspaceFileMentionResolver(serviceFor).resolve(command, target, new AbortController().signal)).toBe(command);
    expect(serviceFor).not.toHaveBeenCalled();
  },
);

test('returns enrichment from the exact selected workspace', async () => {
  const signal = new AbortController().signal;
  const service = { resolve: mock(async () => 'Synthetic expanded context') } satisfies WorkspaceFileMentionService;
  const serviceFor = mock(() => service);
  expect(await new WorkspaceFileMentionResolver(serviceFor).resolve('read @file', target, signal)).toBe('Synthetic expanded context');
  expect(serviceFor).toHaveBeenCalledWith(target);
  expect(service.resolve).toHaveBeenCalledWith({ command: 'read @file', projectPath: target.projectPath }, signal);
});

test('preserves authored input and records only target identifiers when a workspace read fails', async () => {
  const service = { resolve: mock(async () => { throw new Error('Synthetic read failure'); }) } satisfies WorkspaceFileMentionService;
  const signal = new AbortController().signal;
  const warning = mock(() => {});
  expect(await new WorkspaceFileMentionResolver(() => service, { warn: warning }).resolve('read @file', target, signal)).toBe('read @file');
  expect(service.resolve).toHaveBeenCalledWith({ command: 'read @file', projectPath: target.projectPath }, signal);
  expect(warning).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalledWith('File mention resolution unavailable', {
    agentId: target.agentId, ...target.executionLocation, code: null,
  });
});

test.each(['resolve', 'reject'])('preserves cancellation when the workspace read later settles: %s', async (settlement) => {
  const deferred = Promise.withResolvers<string>();
  const service = { resolve: () => deferred.promise } satisfies WorkspaceFileMentionService;
  const cancellation = new AbortController();
  const pending = new WorkspaceFileMentionResolver(() => service).resolve('read @file', target, cancellation.signal);
  const reason = new Error('Synthetic cancellation');
  cancellation.abort(reason);
  if (settlement === 'resolve') deferred.resolve('late context');
  else deferred.reject(new Error('Synthetic read failure'));
  await expect(pending).rejects.toBe(reason);
});

test('rejects pre-aborted input without selecting a workspace', async () => {
  const serviceFor = mock((): WorkspaceFileMentionService => { throw new Error('Unexpected workspace lookup'); });
  const reason = new Error('Synthetic cancellation');
  await expect(new WorkspaceFileMentionResolver(serviceFor).resolve('plain command', target, AbortSignal.abort(reason))).rejects.toBe(reason);
  expect(serviceFor).not.toHaveBeenCalled();
});
