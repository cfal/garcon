import { createLocalProviderInstances } from '../../execution-node/local-provider-instance.js';
import { describe, expect, mock, test } from "bun:test";
import { AgentCatalogService } from "../catalog-service.ts";
import { AgentInstanceDirectory } from "../instance-directory.js";

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
              labelKey: "enabled",
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
    forking: {
      async fork() { return { kind: 'unmaterialized' }; },
      async discard() {},
    },
    steering: {
      captureTarget: () => ({}),
      steer: async () => ({ kind: "accepted" }),
    },
    goals: null,
    endpoints: {},
    projectPathUpdates: { prepare: async () => {} },
  };
}

function configuredInstance({ nodeId = "local", id, defaults = false, strict = false, removedAt = null }) {
  const integration = createIntegration();
  integration.catalog.snapshot = mock(async () => ({
    models: [{ value: `${nodeId}/${id}`, label: id, supportsImages: false }],
    defaultModel: `${nodeId}/${id}`, requiresStrictModelDiscovery: strict, generation: null,
  }));
  return { integration, configuration: {
    nodeId, id, agentId: integration.descriptor.id, label: id,
    default: defaults, storageNamespace: `instances/${id}`, removedAt,
  } };
}

function serviceFor(instances, endpointResolver = {
  getModelOptions: () => [], modelSupportsImages: () => false,
}) {
  return new AgentCatalogService({
    instances: new AgentInstanceDirectory(createLocalProviderInstances(instances)), localNodeId: "local",
    defaultAgentIds: ["sample-agent"], endpointResolver,
  });
}

describe("AgentCatalogService", () => {
  test("provider-only calls select the configured local default, not another profile or node", async () => {
    const remote = configuredInstance({ nodeId: "remote", id: "default", defaults: true, strict: true });
    const extra = configuredInstance({ id: "extra", strict: true });
    const local = configuredInstance({ id: "default", defaults: true });
    const service = serviceFor([extra, remote, local]);
    expect((await service.getModels("sample-agent")).map(({ value }) => value)).toEqual(["local/default"]);
    expect((await service.getAgentCatalogEntries()).map(({ defaultModel }) => defaultModel)).toEqual(["local/default"]);
    expect(service.requiresStrictModelDiscovery("sample-agent")).toBe(false);
    expect(extra.integration.catalog.snapshot).not.toHaveBeenCalled();
    expect(remote.integration.catalog.snapshot).not.toHaveBeenCalled();
    expect(await service.getModels("missing-provider")).toEqual([]);
    expect(await service.getAgentCatalogEntry("missing-provider")).toBeNull();
  });

  test("interleaved reads cannot populate another instance's strict-discovery cache", async () => {
    const local = configuredInstance({ id: "default", defaults: true });
    const extra = configuredInstance({ id: "extra", strict: true });
    const remote = configuredInstance({ nodeId: "remote", id: "extra", strict: true });
    const release = Promise.withResolvers();
    const extraSnapshot = await extra.integration.catalog.snapshot();
    extra.integration.catalog.snapshot = mock(() => release.promise);
    const service = serviceFor([local, extra, remote]);
    const ref = { nodeId: "local", instanceId: "extra" };
    const pending = service.getModelsForInstance(ref, { strict: true });
    ref.nodeId = "remote";
    await service.getModels("sample-agent");
    expect(service.requiresStrictModelDiscovery("sample-agent")).toBe(false);
    release.resolve(extraSnapshot);
    expect((await pending)[0].value).toBe("local/extra");
    expect(service.requiresStrictModelDiscoveryForInstance({ nodeId: "local", instanceId: "extra" })).toBe(true);
    expect(service.requiresStrictModelDiscoveryForInstance({ nodeId: "remote", instanceId: "extra" })).toBe(false);
    expect(service.requiresStrictModelDiscovery("sample-agent")).toBe(false);
    await service.getModelsForInstance({ nodeId: "remote", instanceId: "extra" });
    expect(service.requiresStrictModelDiscoveryForInstance({ nodeId: "remote", instanceId: "extra" })).toBe(true);
  });

  test("an unavailable instance rejects exact reads before endpoint merging and never substitutes a default", async () => {
    const local = configuredInstance({ id: "default", defaults: true });
    const removed = configuredInstance({ id: "removed", removedAt: "2026-09-09T00:00:00.000Z" });
    const endpointResolver = { getModelOptions: mock(() => []), modelSupportsImages: () => false };
    const service = serviceFor([local, removed], endpointResolver);
    for (const ref of [
      { nodeId: "local", instanceId: "missing" },
      { nodeId: "local", instanceId: "removed" },
      { nodeId: "offline", instanceId: "default" },
    ]) {
      await expect(service.getModelsForInstance(ref)).rejects.toMatchObject({ code: "NODE_UNAVAILABLE" });
      await expect(service.getAgentCatalogEntryForInstance(ref)).rejects.toMatchObject({ code: "NODE_UNAVAILABLE" });
    }
    expect(local.integration.catalog.snapshot).not.toHaveBeenCalled();
    expect(removed.integration.catalog.snapshot).not.toHaveBeenCalled();
    expect(endpointResolver.getModelOptions).not.toHaveBeenCalled();
  });

  test("removing a local default leaves compatibility APIs empty without choosing another profile", async () => {
    const removed = configuredInstance({ id: "default", defaults: true, removedAt: "2026-09-09T00:00:00.000Z" });
    const extra = configuredInstance({ id: "extra" });
    const remote = configuredInstance({ nodeId: "remote", id: "default", defaults: true });
    const service = serviceFor([removed, extra, remote]);
    expect(await service.getModels("sample-agent")).toEqual([]);
    expect(await service.getAgentCatalogEntries()).toEqual([]);
    expect(await service.modelSupportsImages({ agentId: "sample-agent", model: "synthetic" })).toBe(false);
    expect(extra.integration.catalog.snapshot).not.toHaveBeenCalled();
    expect(remote.integration.catalog.snapshot).not.toHaveBeenCalled();
  });

  test("captures strictness and propagates cancellation without caching a cancelled result", async () => {
    const local = configuredInstance({ id: "default", defaults: true, strict: true });
    const release = Promise.withResolvers();
    const snapshot = await local.integration.catalog.snapshot();
    local.integration.catalog.snapshot = mock(() => release.promise);
    const service = serviceFor([local]);
    const controller = new AbortController();
    const pending = service.getModels("sample-agent", { signal: controller.signal });
    controller.abort(new Error("Synthetic cancellation"));
    release.resolve(snapshot);
    await expect(pending).rejects.toBe(controller.signal.reason);
    expect(service.requiresStrictModelDiscovery("sample-agent")).toBe(false);
    expect(local.integration.catalog.snapshot.mock.calls[0][0].signal).toBe(controller.signal);
    const failure = Promise.withResolvers();
    const error = new Error("Synthetic discovery failure");
    local.integration.catalog.snapshot = mock(() => failure.promise);
    const query = { strict: true };
    const strictRead = service.getModels("sample-agent", query);
    query.strict = false;
    failure.reject(error);
    await expect(strictRead).rejects.toBe(error);
  });

  test("cancellation at the port handoff cannot deliver models or update the strictness cache", async () => {
    const local = configuredInstance({ id: "default", defaults: true, strict: true });
    const directory = new AgentInstanceDirectory(createLocalProviderInstances([local]));
    const controller = new AbortController();
    /** @satisfies {Pick<AgentInstanceDirectory, 'metadataForInstance' | 'defaultFor' | 'catalogForInstance' | 'assertAvailableForInstance'>} */
    const instances = {
      metadataForInstance: directory.metadataForInstance.bind(directory),
      assertAvailableForInstance: directory.assertAvailableForInstance.bind(directory),
      defaultFor: directory.defaultFor.bind(directory),
      catalogForInstance: (ref) => ({
        snapshot: (request, signal) => {
          const result = directory.catalogForInstance(ref).snapshot(request, signal);
          void result.then(() => controller.abort(new Error("Port handoff cancelled")));
          return result;
        },
      }),
    };
    const service = new AgentCatalogService({
      instances, localNodeId: "local", defaultAgentIds: ["sample-agent"],
      endpointResolver: { getModelOptions: () => [], modelSupportsImages: () => false },
    });
    const pending = service.getModels("sample-agent", { signal: controller.signal });
    await expect(pending).rejects.toMatchObject({ message: "Port handoff cancelled" });
    expect(service.requiresStrictModelDiscovery("sample-agent")).toBe(false);
  });

  test("already-aborted public reads reject even when the requested default or instance is absent", async () => {
    const service = serviceFor([]);
    const signal = AbortSignal.abort(new Error("Missing target read cancelled"));
    const query = { signal };
    const ref = { nodeId: "missing", instanceId: "missing" };
    await expect(service.getModels("sample-agent", query)).rejects.toBe(signal.reason);
    await expect(service.getAgentCatalogEntry("sample-agent", query)).rejects.toBe(signal.reason);
    await expect(service.getModelsForInstance(ref, query)).rejects.toBe(signal.reason);
    await expect(service.getAgentCatalogEntryForInstance(ref, query)).rejects.toBe(signal.reason);
  });

  test("merges controller endpoint models only after reading the selected instance", async () => {
    const local = configuredInstance({ id: "default", defaults: true });
    const extra = configuredInstance({ id: "extra" });
    const service = serviceFor([local, extra], {
      getModelOptions: () => [{ value: "endpoint/model", label: "Endpoint", supportsImages: true }],
      modelSupportsImages: () => true,
    });
    const entry = await service.getAgentCatalogEntryForInstance({ nodeId: "local", instanceId: "extra" });
    expect(entry.models.map(({ value }) => value)).toEqual(["local/extra", "endpoint/model"]);
    expect(entry.defaultModel).toBe("local/extra");
    expect((await service.getAgentCatalogEntry("sample-agent")).models.map(({ value }) => value))
      .toEqual(["local/default", "endpoint/model"]);
  });

  test("projects integration-owned capabilities, modes, and settings into the catalog", async () => {
    const integration = createIntegration();
    const service = new AgentCatalogService({
      instances: new AgentInstanceDirectory(createLocalProviderInstances([{
        configuration: {
          nodeId: "local", id: "default", agentId: integration.descriptor.id, label: "Default",
          default: true, storageNamespace: integration.descriptor.id, removedAt: null,
        },
        integration,
      }])),
      localNodeId: "local",
      defaultAgentIds: [integration.descriptor.id],
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
      supportsForkWhileRunning: true,
      supportsSteering: true,
      supportsGoals: false,
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
              labelKey: "enabled",
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

  test("project-path support remains available when no native preparation is needed", async () => {
    const local = configuredInstance({ id: "default", defaults: true });
    local.integration.projectPathUpdates = null;
    const entry = await serviceFor([local]).getAgentCatalogEntry("sample-agent");
    expect(entry.supportsUpdateProjectPath).toBe(true);
  });
});
