import type { AgentIntegration } from '@garcon/server-agent-interface';
import type { IntegrationRegistry } from './integration-registry.js';

export class AgentDirectory {
  constructor(private readonly integrations: IntegrationRegistry) {}

  has(agentId: string): boolean {
    return this.integrations.has(agentId);
  }

  get(agentId: string): AgentIntegration | null {
    return this.integrations.get(agentId);
  }

  require(agentId: string): AgentIntegration {
    return this.integrations.require(agentId);
  }

  list(): readonly AgentIntegration[] {
    return this.integrations.list();
  }
}
