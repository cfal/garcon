import { expect, test } from 'bun:test';
import { redactGitDiagnostic } from '../git-domain-error.js';

test('keeps native reasons outside remote URLs, including when a quoted destination is clipped', () => {
  const diagnostic = [
    "fatal: unable to access 'https://host/it's here\u00a0?token=example': HTTP 403",
    'To ftps://host/not quoted?token=example',
    'remote: policy denied',
    'error: "file:///a path',
    'with no closing quote',
  ].join('\n');
  expect(redactGitDiagnostic(diagnostic)).toBe([
    'fatal: unable to access <remote>: HTTP 403',
    'To <remote>',
    'remote: policy denied',
    'error: <remote>',
  ].join('\n'));
});
