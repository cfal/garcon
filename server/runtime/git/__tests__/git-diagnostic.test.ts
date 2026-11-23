import { expect, test } from 'bun:test';
import { gitServiceError } from '../service-errors.js';

test('redacting a pull remote preserves the later failure reason', () => {
  const error = new Error('git pull failed (exit 128): From https://user:example@host/project\nfatal: Need to specify how to reconcile divergent branches.');
  const result = gitServiceError(error);
  expect(result.message).toContain('From <remote>\nfatal: Need to specify how to reconcile divergent branches.');
  expect(result.message).not.toContain('user:example');
});
