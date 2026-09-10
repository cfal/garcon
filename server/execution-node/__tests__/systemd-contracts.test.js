import { describe, expect, test } from 'bun:test';
import { parseSystemdHelperReply, parseSystemdHelperRequest, parseSystemdIdentity } from '../systemd/contracts.js';
import { systemdExecutionLaunch } from '../systemd/launch.js';
import { identity, launch } from './systemd-fixture.js';

describe('systemd helper contracts', () => {
  test('round-trips exact requests and replies without private or executable payloads', () => {
    for (const request of [{ kind: 'inspect', launch }, { kind: 'stop', identity }]) {
      expect(parseSystemdHelperRequest(JSON.parse(JSON.stringify(request)))).toEqual(request);
      expect(parseSystemdHelperRequest({ ...request, command: ['sh'] })).toBeNull();
    }
    for (const reply of [{ kind: 'ready', identity }, { kind: 'stopped' }, { kind: 'failed', code: 'NODE_CLEANUP_FAILED' }]) {
      expect(parseSystemdHelperReply(reply)).toEqual(reply);
      expect(parseSystemdHelperReply({ ...reply, secret: 'synthetic' })).toBeNull();
    }
    expect(parseSystemdHelperReply({ kind: 'failed', code: 'arbitrary' })).toBeNull();
    expect(parseSystemdHelperRequest({ kind: 'reset-failed', identity })).toBeNull();
  });

  test.each([
    ['unitName', 'user.service'], ['unitName', '--all'], ['unitName', `${launch.unitName}\0`],
    ['invocationId', '0'.repeat(32)], ['invocationId', 'A'.repeat(32)], ['launchId', '0'.repeat(32)],
    ['mainPid', 0], ['mainPid', -1], ['mainPid', 0x1_0000_0000], ['mainPid', '1234'], ['mainPid', NaN],
    ['controlGroup', '/'], ['controlGroup', 'relative'], ['controlGroup', '/user/../wrong'],
    ['controlGroup', '/user//wrong'], ['controlGroup', '/user/.'], ['controlGroup', '/user/path/'],
  ])('rejects malformed %s', (field, value) => {
    expect(parseSystemdIdentity({ ...identity, [field]: value })).toBeNull();
  });

  test('same node has a stable exclusion name and independent launch nonce', () => {
    const first = systemdExecutionLaunch('synthetic-node', '/opt/garcon', ['--execution-node']);
    const second = systemdExecutionLaunch('synthetic-node', '/opt/garcon', ['--execution-node']);
    const third = systemdExecutionLaunch('other-node', '/opt/garcon', []);
    expect(first.identity.unitName).toBe(second.identity.unitName);
    expect(first.identity.launchId).not.toBe(second.identity.launchId);
    expect(first.identity.unitName).not.toBe(third.identity.unitName);
    expect(first.argv.slice(-3)).toEqual(['--', '/opt/garcon', '--execution-node']);
    for (const option of ['--user', '--pipe', '--wait', '--collect', '--service-type=exec', '--expand-environment=no',
      '--property=KillMode=control-group', '--property=SendSIGKILL=yes', '--property=TimeoutStopSec=5s', '--property=Restart=no']) {
      expect(first.argv).toContain(option);
    }
    expect(first.argv.some((option) => option.includes('job-mode=replace') || option.includes('reset-failed'))).toBe(false);
  });

  test('launch arguments remain literal argv without a shell and require an absolute executable', () => {
    const args = ['--execution-node', '--node-config', '/path with spaces/node.json', 'literal;$(command)'];
    const result = systemdExecutionLaunch('synthetic-node', '/opt/garcon', args);
    expect(result.argv.slice(-4)).toEqual(args);
    expect(() => systemdExecutionLaunch('synthetic-node', 'garcon', args)).toThrow();
    expect(() => systemdExecutionLaunch('synthetic-node', '/opt/garcon', ['\0'])).toThrow();
  });
});
