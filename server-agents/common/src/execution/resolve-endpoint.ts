import type { AgentEndpointSelection } from '@garcon/common/agent-execution';
import type { AgentHost } from '@garcon/server-agent-interface';

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
  const credential = await host.apiProviders.resolveCredential({
    reference: selection.credential,
    signal,
  });
  signal.throwIfAborted();
  return {
    selection,
    credential: credential?.value ?? null,
  };
}
