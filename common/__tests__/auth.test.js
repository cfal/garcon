import { expect, test } from 'bun:test';
import { parseChangeUsernameRequest, parseChangePasswordRequest, parseAuthSessionResponse, parseAuthUserResponse, parseAuthStatusResponse, validateUsername, validatePassword, parseAuthTokenIdentity } from '../auth.js';

test('separate credential contracts never admit a combined or blank-password update', () => {
  expect(parseChangeUsernameRequest({ currentPassword: ' exact ', username: ' owner ' })).toEqual({ currentPassword: ' exact ', username: 'owner' });
  expect(() => parseChangeUsernameRequest({ currentPassword: 'password', username: 'owner', newPassword: 'password-next' })).toThrow();
  expect(() => parseChangePasswordRequest({ currentPassword: 'password', newPassword: '' })).toThrow();
  expect(() => parseChangePasswordRequest({ currentPassword: 'password', newPassword: 'password', confirmation: 'password' })).toThrow();
  expect(validatePassword(' password ')).toBe(' password ');
});

test('new usernames remain compatible with ticket labels and password limits remain exact', () => {
  for (const input of ['', ' ', 'x'.repeat(65), 'a\nb', 'a\u2028b', 'a\u0000b', '\ud800']) expect(() => validateUsername(input)).toThrow();
  expect(validateUsername('x'.repeat(64))).toHaveLength(64);
  expect(validatePassword('x'.repeat(128))).toHaveLength(128);
  for (const input of ['x'.repeat(7), 'x'.repeat(129)]) expect(() => validatePassword(input)).toThrow();
});

test('session responses and token identity metadata are validated, not asserted', () => {
  expect(parseAuthSessionResponse({ success: true, user: { id: 'owner-before', username: 'owner-after' }, token: 'token' }).user.id).toBe('owner-before');
  expect(() => parseAuthSessionResponse({ success: true, user: { username: 'owner' }, token: '' })).toThrow();
  expect(parseAuthTokenIdentity({ sub: 'owner', credentialRevision: 1, sid: 'a'.repeat(64) })).toEqual({ ownerKey: 'owner', credentialRevision: 1, sessionId: 'a'.repeat(64) });
  for (const sid of [undefined, '', 'a'.repeat(63), 'z'.repeat(64)]) {
    expect(parseAuthTokenIdentity({ sub: 'owner', credentialRevision: 1, sid })).toBeNull();
  }
  for (const credentialRevision of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1']) expect(parseAuthTokenIdentity({ sub: 'owner', credentialRevision })).toBeNull();
});

test('auth probes reject malformed users and status flags', () => {
  const user = { id: 'original-owner', username: 'current-name' };
  expect(parseAuthUserResponse({ user })).toEqual({ user });
  for (const input of [{}, { user: { id: '', username: 'name' } }, { user, token: 'unexpected' }]) {
    expect(() => parseAuthUserResponse(input)).toThrow();
  }
  const status = { needsSetup: false, isAuthenticated: false, authDisabled: false };
  expect(parseAuthStatusResponse(status)).toEqual(status);
  for (const input of [{}, { ...status, needsSetup: 'false' }, { ...status, user }]) {
    expect(() => parseAuthStatusResponse(input)).toThrow();
  }
});
