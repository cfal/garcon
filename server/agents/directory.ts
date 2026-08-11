import type { AgentIntegrationV4 } from '@garcon/server-agent-interface';
import type { IntegrationRegistry } from './integration-registry.js';

export class AgentDirectory {
  constructor(private readonly integrations: IntegrationRegistry) {}

  has(agentId: string): boolean {
    return this.integrations.has(agentId);
  }

  get(agentId: string): AgentIntegrationV4 | null {
    return this.integrations.get(agentId);
  }

  require(agentId: string): AgentIntegrationV4 {
    return this.integrations.require(agentId);
  }

  list(): readonly AgentIntegrationV4[] {
    return this.integrations.list();
  }
}
