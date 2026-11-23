import { expect, test } from 'bun:test';
import { redactPushDiagnostic } from '../push-diagnostic.js';
import { gitServiceError } from '../service-errors.js';

test.each([
  "Couldn't connect to server",
  "SSL: no alternative certificate subject name matches target hostname 'localhost'",
  'The requested URL returned error: 403',
])('keeps the separately delimited HTTP failure: %s', reason => {
  expect(redactPushDiagnostic(`fatal: unable to access 'https://host/branch': ${reason}`, 'complete-stderr'))
    .toBe(`fatal: unable to access <remote>: ${reason}`);
});

test('redacting a pull remote preserves the later failure reason', () => {
  const error = new Error('git pull failed (exit 128): From https://user:example@host/project\nfatal: Need to specify how to reconcile divergent branches.');
  const result = gitServiceError(error);
  expect(result.message).toContain('From <remote>\nfatal: Need to specify how to reconcile divergent branches.');
  expect(result.message).not.toContain('user:example');
});

test('withholds the tail when a quoted destination has no reliable terminator', () => {
  for (const url of ["'file:///a path'\nprivate suffix'", '"file:///a path\nwith no closing quote']) {
    expect(redactPushDiagnostic('remote: policy denied\nerror: ' + url, 'complete-stderr')).toBe('remote: policy denied\nerror: <remote>');
  }
  expect(redactPushDiagnostic('To ftps://user:example@host/not quoted\nprivate suffix', 'unverified')).toBe('To <remote>');
  expect(redactPushDiagnostic("fatal: unable to access 'https://host/path': ambiguous': reason", 'complete-stderr'))
    .toBe('fatal: unable to access <remote>');
});
