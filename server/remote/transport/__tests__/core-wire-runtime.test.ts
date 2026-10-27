import { expect, test } from 'bun:test';
import { AgentCallError, type AgentDeliveryOutcome, type AgentIntegrationErrorCode } from '@garcon/server-agent-interface';
import { parseCliContext } from '../../../../common/server-runtime.js';
import { DomainError } from '../../../common/domain-error.js';
import { GitServiceError, type GitServiceErrorCode } from '../../../../common/git-error.js';
import { parseTerminalStreamServerMessage, type TerminalErrorCode } from '../../../../common/terminal.js';
import { TerminalError } from '../../../../common/terminal-error.js';
import type { ErrorCode } from '../../../../common/error-codes.js';
import { parseCliHttpResponse } from '../cli-protocol.js';
import { ExecutorRpc } from '../rpc.js';
import { TestSessionTransport } from '../../__tests__/test-session-transport.js';
import core from './fixtures/core-1-runtime.json';

test('core CLI context and status/retry envelopes round-trip unchanged', () => {
  expect(parseCliContext(core.context)).toEqual(core.context);
  for (const reply of core.cli) expect(parseCliHttpResponse(reply)).toEqual(reply);
  for (const reply of [{ status: 302, body: {} }, { status: 200 }, { status: 503, body: {}, retryAfter: 'soon' }]) {
    expect(() => parseCliHttpResponse(reply)).toThrow();
  }
});

test('core terminal frames retain their literal wire representation', () => {
  for (const frame of core.terminal) expect(parseTerminalStreamServerMessage(frame)).toEqual(frame);
});

for (const failure of core.failures) {
  test(`core ${failure.domain ?? 'provider'} error ${failure.code} preserves delivery semantics`, async () => {
    const requestTransport = new TestSessionTransport('synthetic-session', 'synthetic-worker', () => {});
    const replyTransport = new TestSessionTransport('synthetic-session', 'synthetic-controller', () => {});
    const replies: unknown[] = [];
    const requestSocket = requestTransport.attach({ send: frame => replySocket.receive(frame), close() {} });
    const replySocket = replyTransport.attach({ send: frame => { replies.push(JSON.parse(frame)); requestSocket.receive(frame); }, close() {} });
    const caller = new ExecutorRpc(requestTransport);
    const callee = new ExecutorRpc(replyTransport);
    let error: Error;
    switch (failure.domain) {
      case 'executor':
        error = new DomainError(failure.code as ErrorCode, failure.message, failure.status!, failure.retryable);
        break;
      case 'git':
        error = new GitServiceError(failure.code as GitServiceErrorCode, failure.message);
        break;
      case 'terminal':
        error = new TerminalError(failure.code as TerminalErrorCode, failure.message, failure.status!);
        break;
      default:
        error = new AgentCallError(failure.outcome as AgentDeliveryOutcome, failure.message, failure.code as AgentIntegrationErrorCode);
    }
    callee.handle(async () => { throw error; });
    try {
      await expect(caller.call('synthetic', 'execution.runningSessions', null)).rejects.toMatchObject({
        code: failure.code, message: failure.message,
        ...(failure.outcome ? { outcome: failure.outcome } : {}),
        ...(failure.status ? { status: failure.status } : {}),
      });
      expect(replies[0]).toEqual({ type: 'error', id: expect.any(String), error: failure });
      expect(requestTransport.connected).toBe(true);
    } finally { requestTransport.close(); replyTransport.close(); }
  });
}
