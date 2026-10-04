import type { CliLoginOutputError } from '@garcon/server-agent-common/auth/cli-login-controller';

export const CLAUDE_INCOMPLETE_AUTH_CODE_ERROR =
  'Paste the complete authorization code, including the # suffix, and submit it again.';

export function validateClaudeAuthCode(code: string): string | null {
  const [authorizationCode, suffix] = code.split('#');
  return authorizationCode?.trim() && suffix?.trim() && !/[\r\n]/.test(code)
    ? null
    : CLAUDE_INCOMPLETE_AUTH_CODE_ERROR;
}

export function parseClaudeAuthLoginError(line: string): CliLoginOutputError | null {
  if (line.trim() === 'Invalid code. Please make sure the full code was copied.') {
    return { retryable: true, message: CLAUDE_INCOMPLETE_AUTH_CODE_ERROR };
  }
  if (line.trim().startsWith('Login failed:')) {
    return {
      retryable: false,
      message: 'Claude could not complete sign-in. Start a new sign-in attempt.',
    };
  }
  return null;
}
