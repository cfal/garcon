import {
  AgentIntegrationError,
  type AgentNativeForkResolution,
  type AgentRunFailureDetail,
} from '@garcon/server-agent-interface';

export function nativeForkUnavailableMessage(
  reason: Extract<AgentNativeForkResolution, { readonly kind: 'unavailable' }>['reason'],
): string {
  switch (reason) {
    case 'below-native-retention-floor':
      return 'The selected message is visible but no longer retained by the provider for forking';
    case 'no-native-source':
      return 'The selected message has no provider-native fork position';
    case 'projection-ahead-of-provider':
      return 'The selected message has not reached provider-native storage yet';
    case 'not-settled':
      return 'The selected message is not settled for provider-native forking';
    case 'source-diverged':
      return 'The provider-native session diverged from the selected transcript entry';
  }
}

export function dispatchFailureDetail(error: unknown): AgentRunFailureDetail {
  if (error instanceof AgentIntegrationError) {
    return { code: error.code, ...(error.message ? { message: error.message } : {}) };
  }
  return {
    code: 'DISPATCH_FAILED',
    ...(error instanceof Error && error.message ? { message: error.message } : {}),
  };
}
