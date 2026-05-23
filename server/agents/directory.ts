import type { Agent } from './types.js';

export class AgentDirectory {
  readonly #agents = new Map<string, Agent>();

  constructor(agents: readonly Agent[]) {
    for (const agent of agents) {
      this.#agents.set(agent.id, agent);
    }
  }

  has(agentId: string): boolean {
    return this.#agents.has(agentId);
  }

  get(agentId: string): Agent | null {
    return this.#agents.get(agentId) ?? null;
  }

  require(agentId: string): Agent {
    const agent = this.get(agentId);
    if (!agent) throw new Error(`Unsupported agent: ${agentId}`);
    return agent;
  }

  list(): Agent[] {
    return [...this.#agents.values()];
  }
}
