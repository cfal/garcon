import { AgentIntegrationError } from '@garcon/server-agent-interface';

export function classifyClaudeError(error: unknown): AgentIntegrationError {
  if (error instanceof AgentIntegrationError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  let code: AgentIntegrationError['code'] = 'PROVIDER_FAILURE';
  if (normalized.includes('auth') || normalized.includes('login')) {
    code = 'AUTH_REQUIRED';
  } else if (normalized.includes('rate limit') || normalized.includes('429')) {
    code = 'RATE_LIMITED';
  } else if (normalized.includes('timeout') || normalized.includes('timed out')) {
    code = 'TIMEOUT';
  }
  return new AgentIntegrationError(code, message, code !== 'AUTH_REQUIRED');
}
