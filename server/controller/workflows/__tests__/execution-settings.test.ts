import { expect, test } from 'bun:test';
import { createEmptyAgentSettings } from '../../../../common/agent-settings.js';
import type { ModelCatalogResponse } from '../../../../common/model-catalog.js';
import type { Preamble } from '../../../../common/preambles.js';
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
  inspectProject: async () => { throw new Error('Offline folders must not be inspected.'); },
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

test('authored settings must belong to the resolved agent, even without an explicit agent ID', async () => {
  const implicit = { ...step, agentId: undefined, model: 'remote-model', agentSettings: createEmptyAgentSettings('codex') };
  const context = { defaultTarget: location };
  const fallback = await prepareWorkflowSettings([implicit], context, { ...source, recents: () => [] });
  expect(() => fallback(implicit, location)).toThrow('Step "inspect"');
  const recent = await prepareWorkflowSettings([implicit], context, source);
  expect(recent(implicit, location)).toMatchObject({ agentId: 'codex', agentSettings: implicit.agentSettings });
  expect(() => recent({ ...implicit, agentSettings: createEmptyAgentSettings('claude') }, location)).toThrow('resolved agent "codex"');
});

const scopedPreamble = (id: string, executorId: string): Preamble => ({ id, createdAt: '', updatedAt: '', enabled: true,
  title: 'Review', content: 'Review changes.', agentIds: ['codex'], tagFilter: { mode: 'any', tags: ['review'] },
  scope: { type: 'project-paths', rules: [{ executorId, projectPath: '/canonical/review', includeNested: true }] } });
const nativeCatalog: ModelCatalogResponse = { catalog: { apiProviders: [], agents: [{
  id: 'codex', label: 'Codex', kind: 'agent', selectionLabel: 'Model', inputFormatByModel: {}, executionPolicy: 'conversation',
  generation: null, models: [{ value: 'test-model', label: 'Test model' }], defaultModel: 'test-model',
  supportedPermissionModes: ['default'], supportedThinkingModes: ['none'], settings: [], defaultSettings: createEmptyAgentSettings('codex'),
  supportsCompact: false, supportsFork: false, supportsForkAtMessage: false, supportsForkWhileRunning: false,
  supportsSteering: false, supportsUpdateProjectPath: false, supportsImages: false, acceptsApiProviderEndpoints: false,
  supportedProtocols: [], authLoginSupported: false, requiresStrictModelDiscovery: true,
}] } };

test('workflow defaults inspect each executor-qualified folder once and match its canonical path', async () => {
  const inspect = { ...step, tags: ['review'], model: 'test-model' };
  const inspectAgain = { ...inspect, id: 'again' };
  const local = { ...inspect, id: 'local', executorId: 'local', projectPath: location.projectPath };
  const inspected: string[] = [];
  const capture = await prepareWorkflowSettings([inspect, inspectAgain, local], { defaultTarget: location }, {
    ...source, ready: () => true, catalog: async () => nativeCatalog,
    preambles: () => ({ revision: 1, preambles: [scopedPreamble('remote-rule', remote), scopedPreamble('local-rule', 'local')] }),
    async inspectProject(path, id) {
      expect(path).toBe(location.projectPath);
      inspected.push(String(id));
      return { kind: 'available', effectiveProjectKey: id === remote ? '/canonical/review/nested' : '/canonical/other' };
    },
  });
  expect(inspected).toEqual([remote, 'local']);
  expect(capture(inspect, location).orderedPreambleIds).toEqual(['remote-rule']);
  expect(capture(inspectAgain, location).orderedPreambleIds).toEqual(['remote-rule']);
  expect(capture(local, { executorId: 'local', projectPath: location.projectPath }).orderedPreambleIds).toEqual([]);
});

test('offline defaults need a canonical folder only for matching scope, agent and tags; an explicit list is sufficient', async () => {
  const inspect = { ...step, tags: ['review'] };
  const ctx = { defaultTarget: location };
  const options = { ...source, preambles: () => ({ revision: 1, preambles: [scopedPreamble('remote-rule', remote)] }) };
  const capture = await prepareWorkflowSettings([inspect], ctx, options);
  expect(() => capture(inspect, location)).toThrow('reconnect executor');
  expect(capture({ ...inspect, orderedPreambleIds: [] }, location).orderedPreambleIds).toEqual([]);
  expect(capture(step, location).orderedPreambleIds).toEqual([]);
  const elsewhere = await prepareWorkflowSettings([inspect], ctx, { ...source,
    preambles: () => ({ revision: 1, preambles: [scopedPreamble('local-rule', 'local')] }) });
  expect(elsewhere(inspect, location).orderedPreambleIds).toEqual([]);
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
    confirmChat() { throw new Error('No chat should have been published.'); },
    emit() { throw new Error('No signal should have been observed.'); },
  } satisfies WorkflowAttemptCallbacks;
  const result = await runner.run({ runId: 'r', stepId: 's', instanceId: 'i', attemptId: 'a', attemptNumber: 1,
    location, kind: 'agent', prompt: 'Inspect.', signals: {}, settings: { ...saved, permissionMode: 'default',
      thinkingMode: 'none', agentSettings: createEmptyAgentSettings('codex'), attachments: [{ path: 'sample.txt' }] } }, callbacks);
  expect(preflight).toBe(1);
  expect(result.kind).toBe('unavailable');
});
