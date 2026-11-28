import { expect, test } from 'bun:test';
import {
  optionalAgentHandoffRequest, optionalAgentSettings, optionalApiProtocol, optionalPermissionMode,
  optionalThinkingMode, parseAgentHandoffCommandRequest, requiredAgentSettings,
} from '../../../../../common/chat-execution-command-parsing.ts';

const settings = { ownerId: 'codex', schemaVersion: 1, values: {} };
const handoff = {
  target: { executorId: 'local', projectPath: '/work ', agentId: 'codex', model: 'fixture-model', agentSettings: settings },
  expectedAgentOwnershipEpoch: 'epoch',
};

test('records the direct handoff parser and nullable target fields', () => {
  expect(optionalAgentHandoffRequest(undefined)).toBeUndefined();
  expect(optionalAgentHandoffRequest(handoff)).toEqual(handoff);
  expect(() => optionalAgentHandoffRequest(null)).toThrow('request body must be an object');
  expect(optionalAgentHandoffRequest({ ...handoff, target: { ...handoff.target, executorId: null } })).toEqual(handoff);
  expect(optionalAgentHandoffRequest({ ...handoff, target: { ...handoff.target, executorId: undefined } })?.target.executorId).toBeUndefined();
  expect(() => optionalAgentHandoffRequest({ ...handoff, target: { ...handoff.target, executorId: 'invalid' } }))
    .toThrow('handoff.target.executorId is invalid');
  expect(() => optionalAgentHandoffRequest({ ...handoff, target: { ...handoff.target, modelEndpointId: 'endpoint' } }))
    .toThrow('handoff.target.apiProviderId is required with modelEndpointId');
  expect(() => optionalAgentHandoffRequest({ ...handoff, target: { ...handoff.target, agentId: 'other' } }))
    .toThrow('handoff.target.agentSettings must be owned by handoff.target.agentId');
  const input = { chatId: '1783725900000000', clientRequestId: 'fixture-request', handoff };
  expect(parseAgentHandoffCommandRequest(input)).toEqual(input);
  expect(() => parseAgentHandoffCommandRequest({ ...input, handoff: undefined })).toThrow('handoff is required');
});

test('records strict modes, three-state protocol, and settings', () => {
  expect(optionalPermissionMode('plan')).toBe('plan');
  expect(optionalPermissionMode(null)).toBeUndefined();
  expect(() => optionalPermissionMode('bad')).toThrow('permissionMode is invalid');
  expect(optionalThinkingMode('high')).toBe('high');
  expect(optionalThinkingMode(undefined)).toBeUndefined();
  expect(() => optionalThinkingMode('think')).toThrow('thinkingMode is invalid');
  expect(optionalApiProtocol('openai-compatible')).toBe('openai-compatible');
  expect(optionalApiProtocol(undefined)).toBeUndefined();
  expect(optionalApiProtocol(null)).toBeNull();
  expect(() => optionalApiProtocol('bad')).toThrow('modelProtocol is invalid');
  expect(requiredAgentSettings(settings, 'settings')).toEqual(settings);
  expect(() => requiredAgentSettings(null, 'settings')).toThrow('settings is invalid');
  expect(optionalAgentSettings(settings, 'settings')).toEqual(settings);
  expect(optionalAgentSettings(null, 'settings')).toBeUndefined();
  expect(() => optionalAgentSettings({}, 'settings')).toThrow('settings is invalid');
});
