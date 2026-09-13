import { expect, test } from 'bun:test';
import { NodeDeadline } from '../deadline.js';

test('remaining budgets never increase and fractional elapsed time cannot extend the original deadline', () => {
  let elapsedMs = 100;
  const deadline = new NodeDeadline(10, { read: () => ({ elapsedMs, discontinuity: false }) });
  expect(deadline.remainingMs).toBe(10);
  elapsedMs = 104.5;
  expect(deadline.remainingMs).toBe(5);
  elapsedMs = 109.9;
  expect(deadline.remainingMs).toBe(0);
  elapsedMs = 110;
  expect(deadline.remainingMs).toBe(0);
  elapsedMs = 100;
  expect(deadline.remainingMs).toBe(0);
});

test.each([NaN, Infinity, -1, 99])('an invalid or regressed clock exhausts the budget permanently: %s', (reading) => {
  let elapsedMs = 100;
  const deadline = new NodeDeadline(100, { read: () => ({ elapsedMs, discontinuity: false }) });
  elapsedMs = reading;
  expect(deadline.remainingMs).toBe(0);
  elapsedMs = 100;
  expect(deadline.remainingMs).toBe(0);
});

test('suspension uncertainty exhausts the budget even when elapsed time appears unchanged', () => {
  let discontinuity = false;
  const deadline = new NodeDeadline(100, { read: () => ({ elapsedMs: 0, discontinuity }) });
  discontinuity = true;
  expect(deadline.remainingMs).toBe(0);
  discontinuity = false;
  expect(deadline.remainingMs).toBe(0);
});

test.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('invalid durations fail before creating a budget: %s', (duration) => {
  expect(() => new NodeDeadline(duration)).toThrow('Invalid node deadline');
});

test.each([[10_000, 9_750], [100, 90], [1, 1]])('received budget %s reserves bounded reply time', (received, remaining) => {
  expect(NodeDeadline.receive(received!, { read: () => ({ elapsedMs: 0, discontinuity: false }) }).remainingMs).toBe(remaining);
});
