import { expect, test } from 'bun:test';
import { jsonErrorFromUnknown } from '../../../common/http-error.js';
import {
  STEER_NOT_DELIVERED_MESSAGE,
  STEER_OUTCOME_UNKNOWN_MESSAGE,
  SteerDeliveryError,
} from '../steering-errors.js';

test('sanitizes strict steering delivery failures without making them retryable', async () => {
  const notSent = new SteerDeliveryError(new Error('/secret/pre-send failure'), 'not-sent');
  const unknown = new SteerDeliveryError(new Error('turn/steer transport closed'), 'unknown');
  const [notSentBody, unknownBody] = await Promise.all([
    jsonErrorFromUnknown(notSent).json(),
    jsonErrorFromUnknown(unknown).json(),
  ]);

  expect(notSentBody).toMatchObject({
    error: STEER_NOT_DELIVERED_MESSAGE,
    errorCode: 'STEER_NOT_DELIVERED',
    retryable: false,
  });
  expect(unknownBody).toMatchObject({
    error: STEER_OUTCOME_UNKNOWN_MESSAGE,
    errorCode: 'STEER_OUTCOME_UNKNOWN',
    retryable: false,
  });
  expect(JSON.stringify([notSentBody, unknownBody])).not.toContain('/secret');
  expect(JSON.stringify([notSentBody, unknownBody])).not.toContain('turn/steer');
});
