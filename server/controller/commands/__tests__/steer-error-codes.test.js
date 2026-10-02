import { expect, test } from 'bun:test';
import {
  queueSteerErrorCode,
  steerErrorCode,
  steerErrorStatus,
} from '../steer-error-codes.js';

const inlineErrors = [
  ['VALIDATION_FAILED', 400],
  ['SESSION_NOT_FOUND', 404],
  ['IDEMPOTENCY_CONFLICT', 409],
  ['OPERATION_UNSUPPORTED', 422],
  ['SERVER_SHUTTING_DOWN', 503],
  ['EXECUTOR_UNAVAILABLE', 503],
  ['STEER_NOT_DELIVERED', 500],
  ['STEER_OUTCOME_UNKNOWN', 500],
  ['STEER_PROVIDER_REJECTED', 409],
  ['STEER_TURN_UNAVAILABLE', 409],
  ['STEER_TURN_CHANGED', 409],
  ['STEER_TURN_NOT_STEERABLE', 409],
  ['STEER_CAPACITY_EXHAUSTED', 503],
];
const queueErrors = [
  ['QUEUE_ENTRY_NOT_FOUND', 404],
  ['QUEUE_ENTRY_ALREADY_SENT', 409],
  ['QUEUE_ENTRY_IN_FLIGHT', 409],
  ['QUEUE_ENTRY_REVISION_CONFLICT', 409],
  ['QUEUE_ENTRY_REORDER_CONFLICT', 409],
  ['QUEUE_STEER_FINALIZATION_FAILED', 500],
  ['QUEUE_STEER_RECOVERY_FAILED', 500],
];

test.each(inlineErrors)('retains %s and its status for both steering paths', (code, status) => {
  expect(steerErrorCode(code)).toBe(code);
  expect(queueSteerErrorCode(code)).toBe(code);
  expect(steerErrorStatus(steerErrorCode(code))).toBe(status);
  expect(steerErrorStatus(queueSteerErrorCode(code))).toBe(status);
});

test.each(queueErrors)('keeps %s exclusive to queued steering', (code, status) => {
  expect(steerErrorCode(code)).toBe('INTERNAL_ERROR');
  expect(steerErrorStatus(steerErrorCode(code))).toBe(500);
  expect(queueSteerErrorCode(code)).toBe(code);
  expect(steerErrorStatus(queueSteerErrorCode(code))).toBe(status);
});

test.each([undefined, '', 'INTERNAL_ERROR', 'TRANSCRIPT_UNAVAILABLE', 'unknown', 'toString', '__proto__'])(
  'sanitizes unrecognized recorded error %s', (code) => {
    expect(steerErrorCode(code)).toBe('INTERNAL_ERROR');
    expect(queueSteerErrorCode(code)).toBe('INTERNAL_ERROR');
    expect(steerErrorStatus(steerErrorCode(code))).toBe(500);
    expect(steerErrorStatus(queueSteerErrorCode(code))).toBe(500);
  },
);
