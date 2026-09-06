import { describe, expect, it } from 'bun:test';
import {
  parseProjectResolutionResponse,
  projectTargetKey,
} from '../project-resolution.ts';

const CHAT_ID = '1783725900000800';

describe('project resolution contract', () => {
  it('round-trips both target and resolution variants', () => {
    expect(parseProjectResolutionResponse({
      target: { kind: 'chat', chatId: CHAT_ID, projectPath: '/workspace/project' },
      resolution: { kind: 'available', effectiveProjectKey: '/real/project' },
    })).toEqual({
      target: { kind: 'chat', chatId: CHAT_ID, projectPath: '/workspace/project' },
      resolution: { kind: 'available', effectiveProjectKey: '/real/project' },
    });
    expect(parseProjectResolutionResponse({
      target: { kind: 'path', projectPath: '/workspace/missing' },
      resolution: { kind: 'unavailable', reason: 'not-found' },
    })).toEqual({
      target: { kind: 'path', projectPath: '/workspace/missing' },
      resolution: { kind: 'unavailable', reason: 'not-found' },
    });
  });

  it('rejects malformed and open-ended payloads', () => {
    for (const value of [
      null,
      {},
      {
        target: { kind: 'chat', chatId: 'chat', projectPath: '/workspace/project' },
        resolution: { kind: 'available', effectiveProjectKey: '/real/project' },
      },
      {
        target: { kind: 'path', projectPath: ' ' },
        resolution: { kind: 'unavailable', reason: 'missing' },
      },
      {
        target: { kind: 'path', projectPath: '/workspace/project', extra: true },
        resolution: { kind: 'available', effectiveProjectKey: '/real/project' },
      },
      {
        target: { kind: 'path', projectPath: '/workspace/project' },
        resolution: { kind: 'available', effectiveProjectKey: '', reason: 'not-found' },
      },
    ]) {
      expect(parseProjectResolutionResponse(value)).toBeNull();
    }
  });

  it('keys declared chat and raw-path targets separately', () => {
    expect(projectTargetKey({ kind: 'chat', chatId: CHAT_ID, projectPath: '/project' }))
      .not.toBe(projectTargetKey({ kind: 'path', projectPath: '/project' }));
  });
});
