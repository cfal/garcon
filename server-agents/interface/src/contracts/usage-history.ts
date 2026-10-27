import type { AgentUsageReport, UsageReadRequest } from '@garcon/common/usage';

export interface AgentUsageReadRequest extends UsageReadRequest {
  readonly signal?: AbortSignal;
}

// Reads token usage from the provider's native transcripts on this executor,
// including sessions Garcon did not start. Reads are side-effect free.
export interface AgentUsageHistory {
  read(request: AgentUsageReadRequest): Promise<AgentUsageReport>;
}
