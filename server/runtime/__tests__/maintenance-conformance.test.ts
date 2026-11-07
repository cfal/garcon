import { expect, test } from 'bun:test';
import { validateAgentIntegration } from '@garcon/server-agent-interface/testing';
import { integrationFixture } from '../../remote/__tests__/integration-fixture.js';
import { RuntimeMaintenance } from '../maintenance.js';
import { IntegrationRegistry } from '../agents/integration-registry.js';

test('maintenance preserves optional facet capability presence through provider validation', () => {
  const { integration } = integrationFixture();
  const integrationClass = { integrationId: integration.descriptor.id, apiVersion: 5 as const };
  validateAgentIntegration({ integration, integrationClass });
  const wrapped = new RuntimeMaintenance().integration(integration);
  expect(Object.hasOwn(wrapped.singleQuery!, 'runsToolsWithoutPermission')).toBe(false);
  expect(() => validateAgentIntegration({ integration: wrapped, integrationClass })).not.toThrow();
  expect(() => new IntegrationRegistry({ instances: [wrapped] })).not.toThrow();
  expect(wrapped.constructor).toBe(integration.constructor);
  const permissive = { ...integration, singleQuery: { ...integration.singleQuery, runsToolsWithoutPermission: true as const } };
  const permissiveWrapper = new RuntimeMaintenance().integration(permissive);
  expect(permissiveWrapper.singleQuery!.runsToolsWithoutPermission).toBe(true);
  expect(() => validateAgentIntegration({ integration: permissiveWrapper, integrationClass })).not.toThrow();
});
