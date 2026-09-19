import type { AgentIntegration } from '@garcon/server-agent-interface';
import type { IntegrationRegistry } from './integration-registry.js';
import { effectiveNodeId, LOCAL_EXECUTION_NODE_ID, type AgentExecutionTarget } from '../../common/execution-nodes.js';
import { DomainError } from '../lib/domain-error.js';

export interface ExecutionIntegrationDirectory {
  requireIntegration(target: AgentExecutionTarget): AgentIntegration;
  knownIntegration(target: AgentExecutionTarget): AgentIntegration | null;
  integrationsFor(nodeId: string): IntegrationRegistry;
  isReady(nodeId: string): boolean;
}

export class AgentDirectory {
  constructor(
    private readonly integrations: IntegrationRegistry,
    private readonly nodes?: ExecutionIntegrationDirectory,
  ) {}

  has(agentId: string, nodeId?: string | null): boolean {
    return this.get(agentId, nodeId) !== null;
  }

  get(agentId: string, nodeId?: string | null): AgentIntegration | null {
    if (this.nodes) return this.nodes.knownIntegration({ agentId, nodeId: effectiveNodeId(nodeId) });
    return effectiveNodeId(nodeId) === LOCAL_EXECUTION_NODE_ID ? this.integrations.get(agentId) : null;
  }

  require(agentId: string, nodeId?: string | null): AgentIntegration {
    if (this.nodes) return this.nodes.requireIntegration({ agentId, nodeId: effectiveNodeId(nodeId) });
    if (effectiveNodeId(nodeId) !== LOCAL_EXECUTION_NODE_ID) {
      throw new DomainError('EXECUTION_NODE_UNAVAILABLE', 'Execution node is unavailable', 503, true);
    }
    return this.integrations.require(agentId);
  }

  list(nodeId?: string | null): readonly AgentIntegration[] {
    if (this.nodes) return this.nodes.integrationsFor(effectiveNodeId(nodeId)).list();
    if (effectiveNodeId(nodeId) !== LOCAL_EXECUTION_NODE_ID) {
      throw new DomainError('EXECUTION_NODE_UNAVAILABLE', 'Execution node is unavailable', 503, true);
    }
    return this.integrations.list();
  }

  isReady(nodeId?: string | null): boolean {
    return this.nodes?.isReady(effectiveNodeId(nodeId)) ?? effectiveNodeId(nodeId) === LOCAL_EXECUTION_NODE_ID;
  }
}
