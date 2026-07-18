import type {
  AgentIntegration,
  AgentIntegrationClass,
} from '../index.js';

export interface AgentIntegrationConformanceOptions {
  readonly integrationClass: Pick<AgentIntegrationClass, 'integrationId' | 'apiVersion'>;
  readonly integration: AgentIntegration;
}

export function validateAgentIntegration(
  options: AgentIntegrationConformanceOptions,
): void {
  const { integration, integrationClass } = options;
  if (integrationClass.apiVersion !== 1) {
    throw new Error(`Unsupported agent integration API version: ${integrationClass.apiVersion}`);
  }
  if (integrationClass.integrationId !== integration.descriptor.id) {
    throw new Error(
      `Agent integration ID mismatch: ${integrationClass.integrationId} != ${integration.descriptor.id}`,
    );
  }
  if (!integration.execution || !integration.transcript || !integration.transcriptSearch) {
    throw new Error(`Agent integration ${integration.descriptor.id} is missing a required facet`);
  }
  if (!integration.catalog || !integration.settings || !integration.lifecycle || !integration.migration) {
    throw new Error(`Agent integration ${integration.descriptor.id} is missing a required service facet`);
  }
}
