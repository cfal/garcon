import { isRecord } from './json.js';

export interface AuthUser { readonly id: string; readonly username: string }
export interface AuthSessionResponse { readonly success: true; readonly user: AuthUser; readonly token: string }
export interface AuthUserResponse { readonly user: AuthUser }
export interface AuthStatusResponse { readonly needsSetup: boolean; readonly isAuthenticated: boolean; readonly authDisabled: boolean }
export interface ChangeUsernameRequest { readonly currentPassword: string; readonly username: string }
export interface ChangePasswordRequest { readonly currentPassword: string; readonly newPassword: string }
export interface LoginRequest { readonly username: string; readonly password: string }
export interface AuthTokenIdentity { readonly ownerKey: string; readonly credentialRevision: number }

export class AuthValidationError extends Error {}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new AuthValidationError('Unexpected authentication fields.');
  }
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.length) throw new AuthValidationError(`${field} is required.`);
  return value;
}

export function validateUsername(value: unknown): string {
  const username = text(value, 'Username').trim();
  if (!username || username.length > 64 || !username.isWellFormed()
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(username)) {
    throw new AuthValidationError('Username must contain 1-64 characters on one line without controls.');
  }
  return username;
}

export function validatePassword(value: unknown): string {
  const password = currentPassword(value);
  if (password.length < 8) throw new AuthValidationError('Password must be at least 8 characters.');
  return password;
}

function currentPassword(value: unknown): string {
  const password = text(value, 'Password');
  if (password.length > 128) throw new AuthValidationError('Password must be 128 characters or fewer.');
  return password;
}

export function parseChangeUsernameRequest(value: unknown): ChangeUsernameRequest {
  const raw = record(value, ['currentPassword', 'username']);
  return { currentPassword: currentPassword(raw.currentPassword), username: validateUsername(raw.username) };
}

export function parseChangePasswordRequest(value: unknown): ChangePasswordRequest {
  const raw = record(value, ['currentPassword', 'newPassword']);
  return { currentPassword: currentPassword(raw.currentPassword), newPassword: validatePassword(raw.newPassword) };
}

export function parseLoginRequest(value: unknown): LoginRequest {
  const raw = record(value, ['username', 'password']);
  return { username: text(raw.username, 'Username'), password: currentPassword(raw.password) };
}

export function parseRegisterRequest(value: unknown): LoginRequest {
  const raw = record(value, ['username', 'password']);
  return { username: validateUsername(raw.username), password: validatePassword(raw.password) };
}

export function parseAuthUser(value: unknown): AuthUser {
  const raw = record(value, ['id', 'username']);
  return { id: text(raw.id, 'Owner'), username: text(raw.username, 'Username') };
}

export function parseAuthSessionResponse(value: unknown): AuthSessionResponse {
  const raw = record(value, ['success', 'user', 'token']);
  if (raw.success !== true) throw new AuthValidationError('Invalid authentication response.');
  return { success: true, user: parseAuthUser(raw.user), token: text(raw.token, 'Token') };
}

export function parseAuthUserResponse(value: unknown): AuthUserResponse {
  const raw = record(value, ['user']);
  return { user: parseAuthUser(raw.user) };
}

export function parseAuthStatusResponse(value: unknown): AuthStatusResponse {
  const raw = record(value, ['needsSetup', 'isAuthenticated', 'authDisabled']);
  if (typeof raw.needsSetup !== 'boolean' || typeof raw.isAuthenticated !== 'boolean' || typeof raw.authDisabled !== 'boolean') {
    throw new AuthValidationError('Invalid authentication status.');
  }
  return { needsSetup: raw.needsSetup, isAuthenticated: raw.isAuthenticated, authDisabled: raw.authDisabled };
}

export function parseAuthTokenIdentity(value: unknown): AuthTokenIdentity | null {
  if (!isRecord(value) || typeof value.sub !== 'string' || !value.sub
    || typeof value.credentialRevision !== 'number' || !Number.isSafeInteger(value.credentialRevision)
    || value.credentialRevision < 1) return null;
  return { ownerKey: value.sub, credentialRevision: value.credentialRevision };
}
