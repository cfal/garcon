import { expect, test } from 'bun:test';
import { redactGitDiagnostic } from '../git-domain-error.js';

test.each([
  "Couldn't connect to server",
  "SSL: no alternative certificate subject name matches target hostname 'localhost'",
  'The requested URL returned error: 403',
])('keeps the separately delimited HTTP failure: %s', reason => {
  expect(redactGitDiagnostic(`fatal: unable to access 'https://host/branch': ${reason}`))
    .toBe(`fatal: unable to access <remote>: ${reason}`);
});

test('withholds the tail when a quoted destination has no reliable terminator', () => {
  for (const url of ["'file:///a path'\nprivate suffix'", '"file:///a path\nwith no closing quote']) {
    expect(redactGitDiagnostic('remote: policy denied\nerror: ' + url)).toBe('remote: policy denied\nerror: <remote>');
  }
  expect(redactGitDiagnostic('To ftps://user:example@host/not quoted\nprivate suffix')).toBe('To <remote>');
  expect(redactGitDiagnostic("fatal: unable to access 'https://host/path': ambiguous': reason"))
    .toBe('fatal: unable to access <remote>');
});
