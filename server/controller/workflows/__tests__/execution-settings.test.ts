import { expect, test } from 'bun:test';
import { createEmptyAgentSettings } from '../../../../common/agent-settings.js';
import { defaultExecutionDefaults } from '../../../../common/settings.js';
import type { WorkflowAgentStep } from '../../../../common/workflow-definition.js';
import type { AutomationExecutionPort } from '../../automation/service.js';
import { createWorkflowRunner } from '../automation-runner.js';
import type { WorkflowAttemptCallbacks } from '../runner.js';
import { prepareWorkflowSettings, type WorkflowSelectionSource } from '../settings.js';

const remote = '40400000-0000-4000-8000-000000000001';
const location = { executorId: remote, projectPath: '/shared/folder' };
const step: WorkflowAgentStep = { id: 'inspect', kind: 'agent', prompt: 'Inspect.', executorId: remote, agentId: 'codex' };
const saved = { agentId: 'codex', model: 'remote-model', apiProviderId: 'custom', modelEndpointId: 'east', modelProtocol: 'openai-compatible' } as const;
const source = {
  ready: () => false,
  catalog: async () => { throw new Error('Offline catalog must not be consulted.'); },
  defaults: () => ({ global: { ...defaultExecutionDefaults(), permissionMode: 'default' as const }, byAgent: {} }),
  recents: () => [{ ...saved, executorId: 'local', model: 'other' }, { ...saved, executorId: remote }],
  preambles: () => ({ revision: 0, preambles: [] }),
  providerRoute(id, provider, endpoint) {
    expect([id, provider, endpoint]).toEqual([remote, 'custom', 'east']);
    return { revision: 7, protocol: 'openai-compatible' as const };
  },
} satisfies WorkflowSelectionSource;

test('offline steps pin settings from the selected executor, including the assigned provider route', async () => {
  const capture = await prepareWorkflowSettings([step], { defaultTarget: location }, source);
  expect(capture(step, location)).toMatchObject({ ...saved, permissionMode: 'default', providerRevision: 7, orderedPreambleIds: [] });
});

test('offline steps never inherit a bypass grant or borrow a model from Local', async () => {
  const context = { defaultTarget: location };
  const capture = await prepareWorkflowSettings([step], context, { ...source,
    defaults: () => ({ global: { ...defaultExecutionDefaults(), permissionMode: 'bypassPermissions' }, byAgent: {} }),
  });
  expect(() => capture(step, location)).toThrow('explicitly select bypass');
  const missing = await prepareWorkflowSettings([step], context, { ...source, recents: () => [{ ...saved, executorId: 'local' }] });
  expect(() => missing(step, location)).toThrow('Choose one explicitly');
});

test('attachments are read on the step executor and sent using normal chat attachment validation', async () => {
  let preflight = 0;
  const port: AutomationExecutionPort = {
    async prepare(input) {
      preflight++;
      expect(input.executorId).toBe(remote);
      expect(input.images).toEqual([{ name: 'sample.txt', mimeType: 'text/plain', data: 'data:text/plain;base64,YQ==' }]);
      return { kind: 'rejected', code: 'EXECUTOR_UNAVAILABLE', message: 'Offline before admission.' };
    },
    async waitForTerminal() { throw new Error('No turn was prepared.'); },
    async stop() { throw new Error('No turn was prepared.'); },
  };
  const runner = createWorkflowRunner(port, async id => {
    expect(id).toBe(remote);
    return { async read(target) {
      expect(target).toEqual({ projectPath: '/shared/folder', filePath: 'sample.txt' });
      return { path: '/shared/folder/sample.txt', revision: 'v1:1', bytes: new Uint8Array([97]) };
    } };
  });
  const callbacks = {
    signal: new AbortController().signal,
    attachChat() { throw new Error('No chat should have been created.'); },
    emit() { throw new Error('No signal should have been observed.'); },
  } satisfies WorkflowAttemptCallbacks;
  const result = await runner.run({ runId: 'r', stepId: 's', instanceId: 'i', attemptId: 'a', attemptNumber: 1,
    location, kind: 'agent', prompt: 'Inspect.', signals: {}, settings: { ...saved, permissionMode: 'default',
      thinkingMode: 'none', agentSettings: createEmptyAgentSettings('codex'), attachments: [{ path: 'sample.txt' }] } }, callbacks);
  expect(preflight).toBe(1);
  expect(result.kind).toBe('unavailable');
});
