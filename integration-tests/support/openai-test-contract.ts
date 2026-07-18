export const INTEGRATION_OPENAI_API_KEY = 'sk-integration-test';

export function fakeOpenAiRequestHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${INTEGRATION_OPENAI_API_KEY}`,
    'content-type': 'application/json',
  };
}
