export const INTEGRATION_ANTHROPIC_API_KEY = 'sk-ant-integration-test';
export const INTEGRATION_ANTHROPIC_VERSION = '2023-06-01';

export function fakeAnthropicRequestHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-api-key': INTEGRATION_ANTHROPIC_API_KEY,
    'anthropic-version': INTEGRATION_ANTHROPIC_VERSION,
  };
}
