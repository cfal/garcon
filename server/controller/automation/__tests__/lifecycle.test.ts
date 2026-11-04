import { expect, test } from 'bun:test';
import { AutomationLifecycle } from '../lifecycle.js';

const key = { serverInstanceId: 'synthetic-server', chatId: 'synthetic-chat', turnId: 'turn', clientRequestId: 'request' };

test('revokes before notifying and does not accept a matching DTO as provenance', () => {
  const lifecycle = new AutomationLifecycle();
  const lease = lifecycle.acquire(key);
  const actions: string[] = [];
  lifecycle.subscribe(event => { expect(lease.revoked.aborted).toBe(true); actions.push(event.action); });
  lifecycle.observe(key.chatId, 'input', lease);
  expect(lifecycle.owns(lease)).toBe(true);
  lifecycle.observe(key.chatId, 'steer', { ...lease });
  expect(lifecycle.owns(lease)).toBe(false);
  lifecycle.observe(key.chatId, 'stop');
  expect(actions).toEqual(['steer']);
});

test('observer failure fences all leases without throwing into ordinary controls', () => {
  const lifecycle = new AutomationLifecycle();
  const lease = lifecycle.acquire(key);
  const other = lifecycle.acquire({ ...key, chatId: 'other' });
  lifecycle.subscribe(() => { throw new Error('Synthetic observer failure'); });
  expect(() => lifecycle.observe(key.chatId, 'queue')).not.toThrow();
  expect(lease.revoked.aborted).toBe(true);
  expect(other.revoked.aborted).toBe(true);
  expect(lease.actorRevoked.aborted).toBe(true);
  expect(other.actorRevoked.aborted).toBe(false);
  expect(lifecycle.ownsControl(other)).toBe(true);
  expect(lifecycle.owns(other)).toBe(false);
  expect(lifecycle.ownsControl(lease)).toBe(false);
  lifecycle.observe('other', 'input');
  expect(other.actorRevoked.aborted).toBe(true);
  expect(lifecycle.ownsControl(other)).toBe(false);
  expect(() => lifecycle.acquire({ ...key, chatId: 'third' })).toThrow();
});

test('release is bounded, idempotent, and cannot release a successor', () => {
  const lifecycle = new AutomationLifecycle();
  const old = lifecycle.acquire(key);
  old.release();
  const next = lifecycle.acquire({ ...key, turnId: 'next' });
  old.release();
  expect(lifecycle.owns(next)).toBe(true);
  expect(lifecycle.owns(old)).toBe(false);
});
