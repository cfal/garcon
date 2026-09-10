import { describe, expect, test } from 'bun:test';
import {
  executionInstanceKey, parseExecutionLocation, parseExecutionOrigin, projectWorkspaceKey, sameExecutionOwner,
} from '../execution-location.js';
import { parseNodeSessionIdentity, sameNodeSession } from '../node-operation.js';

const location = { nodeId: 'node-a', workspaceId: 'workspace-a', instanceId: 'instance-a' };

describe('execution placement identities', () => {
  test('compares provider, node, instance and workspace separately', () => {
    const owner = { agentId: 'provider-a', executionLocation: location };
    expect(sameExecutionOwner(owner, { ...owner, executionLocation: { ...location } })).toBe(true);
    expect(sameExecutionOwner(owner, { ...owner, agentId: 'provider-b' })).toBe(false);
    for (const key of Object.keys(location)) {
      expect(sameExecutionOwner(owner, { ...owner, executionLocation: { ...location, [key]: 'different' } })).toBe(false);
    }
  });

  test('keeps identical workspace and instance labels on different machines distinct', () => {
    expect(projectWorkspaceKey(location)).not.toBe(projectWorkspaceKey({ ...location, nodeId: 'node-b' }));
    expect(executionInstanceKey(location)).not.toBe(executionInstanceKey({ ...location, nodeId: 'node-b' }));
    expect(projectWorkspaceKey({ nodeId: 'a-b', workspaceId: 'c' }))
      .not.toBe(projectWorkspaceKey({ nodeId: 'a', workspaceId: 'b-c' }));
  });

  test('requires complete explicit references instead of defaulting malformed remote placement to local', () => {
    expect(parseExecutionLocation(location)).toEqual(location);
    for (const value of [null, {}, { ...location, nodeId: '' }, { ...location, instanceId: '../escape' },
      { nodeId: 'remote', instanceId: 'profile' }, { ...location, unexpected: true }]) {
      expect(parseExecutionLocation(value)).toBeNull();
    }
    const origin = { ...location, ownershipEpoch: 'epoch-a', projectPath: 'C:\\synthetic\\project' };
    expect(parseExecutionOrigin(origin)).toEqual(origin);
    expect(parseExecutionOrigin({ ...origin, projectPath: '/path\0invalid' })).toBeNull();
    expect(parseExecutionOrigin({ ...origin, projectPath: '' })).toBeNull();
    expect(parseExecutionOrigin({ ...origin, projectPath: ' \t\r\n' })).toBeNull();
  });

  test('fences both boots and the logical session without conflating a socket attempt', () => {
    const session = { controllerBootId: 'controller-a', nodeBootId: 'node-a', logicalSessionId: 'logical-a' };
    expect(parseNodeSessionIdentity(session)).toEqual(session);
    expect(parseNodeSessionIdentity({ ...session, socketId: 'socket-a' })).toBeNull();
    expect(sameNodeSession(session, { ...session })).toBe(true);
    for (const key of Object.keys(session)) {
      expect(sameNodeSession(session, { ...session, [key]: 'replacement' })).toBe(false);
    }
  });
});
