import type { AgentEndpointSelection } from '@garcon/common/agent-execution';
import type { AgentHost } from '@garcon/server-agent-interface';
import { AgentCallError } from '@garcon/server-agent-interface';

export interface ResolvedAgentEndpoint {
  readonly selection: AgentEndpointSelection;
  readonly credential: string | null;
}

export async function resolveAgentEndpoint(
  host: AgentHost,
  selection: AgentEndpointSelection | null,
  signal: AbortSignal,
): Promise<ResolvedAgentEndpoint | null> {
  signal.throwIfAborted();
  if (!selection) return null;
  if (!selection.credential) return { selection, credential: null };
  let credential: Awaited<ReturnType<AgentHost['apiProviders']['resolveCredential']>>;
  try {
    credential = await host.apiProviders.resolveCredential({ reference: selection.credential, signal });
  } catch (error) {
    // A read that never reached the controller, or whose outcome is unknown, returned
    // no credential, so the caller fails definitely rather than as an uncertain
    // outcome of its own. Unlike a denied credential, the read can succeed when retried.
    if (error instanceof AgentCallError && error.outcome !== 'rejected') {
      signal.throwIfAborted();
      throw new AgentCallError('rejected', 'Provider credential could not be read from the controller. Try again.');
    }
    throw error;
  }
  signal.throwIfAborted();
  if (!credential) throw new AgentCallError('rejected', 'Provider credential is unavailable', 'API_PROVIDER_UNAVAILABLE');
  return {
    selection,
    credential: credential.value,
  };
}
