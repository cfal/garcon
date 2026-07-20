import { describe, expect, test } from "bun:test";
import { AgentCatalogService } from "../catalog-service.ts";

function createIntegration() {
  return {
    descriptor: {
      id: "sample-agent",
      label: "Sample Agent",
      supportedPermissionModes: ["default", "manualBypass"],
      supportedThinkingModes: ["none", "ultra"],
      supportsImages: true,
      supportsProjectPathUpdate: true,
      requiresNativePathForProjectPathUpdate: false,
      supportedEndpointProtocols: ["openai-compatible"],
      configuration: [],
    },
    catalog: {
      snapshot: async () => ({
        models: [
          {
            value: "sample-model",
            label: "Sample Model",
            supportsImages: true,
          },
        ],
        defaultModel: "sample-model",
        requiresStrictModelDiscovery: true,
        generation: { priority: 10, model: "sample-model" },
      }),
    },
    settings: {
      describe: () => [
        {
          key: "effort",
          type: "enum",
          label: "Effort",
          labelKey: "thinking",
          options: [
            {
              value: "high",
              label: "High",
              labelKey: "deep",
              description: "Uses extended thinking for every response.",
              descriptionKey: "thinkingEnabled",
            },
          ],
        },
      ],
      defaults: () => ({
        ownerId: "sample-agent",
        schemaVersion: 2,
        values: { effort: "high" },
      }),
    },
    auth: { launchLogin: async () => ({}) },
    forking: { supportsAtMessage: true, supportsWhileRunning: false },
    endpoints: {},
  };
}

describe("AgentCatalogService", () => {
  test("projects integration-owned capabilities, modes, and settings into the catalog", async () => {
    const integration = createIntegration();
    const service = new AgentCatalogService({
      directory: {
        get: (id) => (id === integration.descriptor.id ? integration : null),
        require: (id) => {
          if (id !== integration.descriptor.id)
            throw new Error("missing integration");
          return integration;
        },
        list: () => [integration],
      },
      endpointResolver: {
        getModelOptions: () => [],
        modelSupportsImages: () => false,
      },
    });

    const entry = await service.getAgentCatalogEntry("sample-agent");

    expect(entry).toMatchObject({
      id: "sample-agent",
      label: "Sample Agent",
      supportsFork: true,
      supportsForkAtMessage: true,
      supportsForkWhileRunning: false,
      supportsUpdateProjectPath: true,
      supportsImages: true,
      acceptsApiProviderEndpoints: true,
      supportedProtocols: ["openai-compatible"],
      authLoginSupported: true,
      supportedPermissionModes: ["default", "manualBypass"],
      supportedThinkingModes: ["none", "ultra"],
      settings: [
        expect.objectContaining({
          key: "effort",
          type: "enum",
          labelKey: "thinking",
          options: [
            expect.objectContaining({
              value: "high",
              labelKey: "deep",
              description: "Uses extended thinking for every response.",
              descriptionKey: "thinkingEnabled",
            }),
          ],
        }),
      ],
      defaultSettings: {
        ownerId: "sample-agent",
        schemaVersion: 2,
        values: { effort: "high" },
      },
      requiresStrictModelDiscovery: true,
      generation: { priority: 10, model: "sample-model" },
      defaultModel: "sample-model",
      models: [
        { value: "sample-model", label: "Sample Model", supportsImages: true },
      ],
    });
  });
});
