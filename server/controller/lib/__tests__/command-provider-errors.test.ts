import { expect, test } from 'bun:test';
import { AgentCallError, AgentIntegrationError } from '@garcon/server-agent-interface';
import { commandHttpError } from '../command-http-error.js';

test.each([
  [new AgentIntegrationError('SESSION_BUSY', 'Session changed', true), 409],
  [new AgentIntegrationError('UNAVAILABLE', 'Catalog unavailable', true), 503],
  [new AgentIntegrationError('TIMEOUT', 'Discovery timed out', true), 504],
  [new AgentIntegrationError('TIMEOUT', 'Settings not confirmed', false), 504],
  [new AgentCallError('unknown', 'Dispatch unconfirmed'), 503],
] as const)('preserves command failure and retry policy: %s', async (error, status) => {
  const response = commandHttpError(error);
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ success: false, errorCode: error.code, error: error.message, retryable: error.retryable });
});
