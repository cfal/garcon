import { describe, expect, it } from 'bun:test';
import {
  CLAUDE_INCOMPLETE_AUTH_CODE_ERROR,
  parseClaudeAuthLoginError,
  validateClaudeAuthCode,
} from '../claude-auth-login.js';

describe('Claude browser login contract', () => {
  it('requires both the authorization code and the provider suffix', () => {
    for (const code of ['', 'synthetic-code', 'synthetic-code#', '#suffix', 'code#suffix\nsecond-input']) {
      expect(validateClaudeAuthCode(code)).toBe(CLAUDE_INCOMPLETE_AUTH_CODE_ERROR);
    }
    expect(validateClaudeAuthCode('synthetic-code#synthetic-suffix')).toBeNull();
  });

  it('maps the CLI rejection to a fixed retry instruction', () => {
    expect(parseClaudeAuthLoginError('Invalid code. Please make sure the full code was copied.')).toEqual({
      retryable: true, message: CLAUDE_INCOMPLETE_AUTH_CODE_ERROR,
    });
  });

  it('maps CLI terminal failure without passing through codes or tokens', () => {
    expect(parseClaudeAuthLoginError('Login failed: token exchange rejected synthetic-secret')).toEqual({
      retryable: false, message: 'Claude could not complete sign-in. Start a new sign-in attempt.',
    });
    expect(parseClaudeAuthLoginError('https://auth.example/code#synthetic-secret')).toBeNull();
    expect(parseClaudeAuthLoginError('Unknown synthetic-secret diagnostic')).toBeNull();
  });
});
