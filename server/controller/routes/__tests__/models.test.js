import { beforeEach, describe, it, expect, mock } from "bun:test";

import createModelsRoutes from "../models.js";
import { ModelCatalogResponseCache } from "../model-catalog-cache.js";
import { DomainError } from '../../../common/domain-error.js';
import { AgentCatalogService } from '../../agents/catalog-service.js';
import { AgentDirectory } from '../../agents/directory.js';
import { IntegrationRegistry } from '../../../runtime/agents/integration-registry.js';
import { integrationFixture } from '../../../remote/__tests__/integration-fixture.js';

const agentCatalogEntries = [
  {
    id: "claude",
    label: "Claude",
    kind: "agent",
    supportsFork: true,
    supportsForkAtMessage: true,
    supportsForkWhileRunning: true,
    supportsUpdateProjectPath: true,
    supportsImages: true,
    acceptsApiProviderEndpoints: true,
    supportedProtocols: ["anthropic-messages"],
    authLoginSupported: true,
    defaultModel: "opus",
    models: [{ value: "opus", label: "Opus", supportsImages: true }],
  },
  {
    id: "codex",
    label: "Codex",
    kind: "agent",
    supportsFork: true,
    supportsForkAtMessage: true,
    supportsForkWhileRunning: true,
    supportsUpdateProjectPath: true,
    supportsImages: true,
    acceptsApiProviderEndpoints: true,
    supportedProtocols: ["openai-compatible"],
    authLoginSupported: true,
    defaultModel: "gpt-5.5",
    models: [
      { value: "gpt-5.5", label: "GPT-5.5", supportsImages: true },
      { value: "gpt-6-astra", label: "GPT-6-Astra", supportsImages: true },
      { value: "gpt-6-sol", label: "GPT-6-Sol", supportsImages: true },
      { value: "gpt-6-luna", label: "GPT-6-Luna", supportsImages: true },
      { value: "gpt-5.6-sol", label: "GPT-5.6-Sol", supportsImages: true },
      { value: "gpt-5.6-terra", label: "GPT-5.6-Terra", supportsImages: true },
      { value: "gpt-5.6-luna", label: "GPT-5.6-Luna", supportsImages: true },
      { value: "gpt-5.4", label: "GPT-5.4", supportsImages: true },
      { value: "gpt-5.3-codex", label: "GPT-5.3 Codex", supportsImages: true },
      {
        value: "gpt-5.3-codex-spark",
        label: "GPT-5.3 Codex Spark",
        supportsImages: false,
      },
    ],
  },
  {
    id: "opencode",
    label: "OpenCode",
    kind: "agent",
    supportsFork: true,
    supportsForkAtMessage: false,
    supportsForkWhileRunning: false,
    supportsUpdateProjectPath: true,
    supportsImages: false,
    acceptsApiProviderEndpoints: false,
    supportedProtocols: [],
    authLoginSupported: false,
    defaultModel: "",
    models: [],
  },
  {
    id: "amp",
    label: "Amp",
    kind: "agent",
    supportsFork: false,
    supportsForkAtMessage: false,
    supportsForkWhileRunning: false,
    supportsUpdateProjectPath: false,
    supportsImages: false,
    acceptsApiProviderEndpoints: false,
    supportedProtocols: [],
    authLoginSupported: false,
    defaultModel: "default",
    models: [{ value: "default", label: "Default" }],
  },
  {
    id: "factory",
    label: "Factory",
    kind: "agent",
    supportsFork: false,
    supportsForkAtMessage: false,
    supportsForkWhileRunning: false,
    supportsUpdateProjectPath: false,
    supportsImages: false,
    acceptsApiProviderEndpoints: false,
    supportedProtocols: [],
    authLoginSupported: false,
    defaultModel: "claude-opus-4-6",
    models: [{ value: "claude-opus-4-6", label: "Claude Opus 4-6" }],
  },
  {
    id: "pi",
    label: "Pi",
    kind: "agent",
    supportsFork: true,
    supportsForkAtMessage: false,
    supportsForkWhileRunning: false,
    supportsUpdateProjectPath: true,
    supportsImages: false,
    acceptsApiProviderEndpoints: false,
    supportedProtocols: [],
    authLoginSupported: false,
    defaultModel: "github-copilot/gpt-5.4",
    models: [
      {
        value: "github-copilot/gpt-5.4",
        label: "github-copilot: gpt-5.4",
        supportsImages: true,
      },
    ],
  },
  {
    id: "direct-anthropic-compatible",
    label: "Direct (Anthropic)",
    kind: "agent",
    supportsFork: true,
    supportsForkAtMessage: true,
    supportsForkWhileRunning: false,
    supportsUpdateProjectPath: true,
    supportsImages: true,
    acceptsApiProviderEndpoints: true,
    supportedProtocols: ["anthropic-messages"],
    authLoginSupported: false,
    defaultModel: "",
    models: [],
  },
  {
    id: "direct-openai-compatible",
    label: "Direct (Chat Completions)",
    kind: "agent",
    supportsFork: true,
    supportsForkAtMessage: true,
    supportsForkWhileRunning: false,
    supportsUpdateProjectPath: true,
    supportsImages: true,
    acceptsApiProviderEndpoints: true,
    supportedProtocols: ["openai-compatible"],
    authLoginSupported: false,
    defaultModel: "",
    models: [],
  },
  {
    id: "direct-openai-responses-compatible",
    label: "Direct (Responses)",
    kind: "agent",
    supportsFork: true,
    supportsForkAtMessage: true,
    supportsForkWhileRunning: false,
    supportsUpdateProjectPath: true,
    supportsImages: true,
    acceptsApiProviderEndpoints: true,
    supportedProtocols: ["openai-compatible"],
    authLoginSupported: false,
    defaultModel: "",
    models: [],
  },
].map((entry) => ({
  ...entry,
  supportsSteering: entry.id === "codex",
  supportedPermissionModes: ["default", "manualBypass"],
  supportedThinkingModes: ["none", "high"],
  settings: [],
  defaultSettings: { ownerId: entry.id, schemaVersion: 1, values: {} },
  requiresStrictModelDiscovery: entry.id === "pi",
  generation: null,
}));

const modelCatalog = {
  agents: {
    assertAgentAvailable: mock(() => {}),
    requiresStrictModelDiscovery: mock(() => false),
    getAgentCatalogEntries: mock(() => Promise.resolve(agentCatalogEntries)),
    getAgentCatalogEntry: mock((agentId) =>
      Promise.resolve(
        agentCatalogEntries.find((agent) => agent.id === agentId) ?? null,
      ),
    ),
  },
  apiProviders: {
    getCatalog: mock(() => []),
  },
};

const responseCache = new ModelCatalogResponseCache();
const modelsRoutes = createModelsRoutes({ modelCatalog, responseCache });
const handler = modelsRoutes["/api/v1/models"].GET;

function discoveryFixture() {
  const executorId = '22222222-2222-4222-8222-222222222222';
  const { integration } = integrationFixture('/synthetic-project', executorId);
  const registry = new IntegrationRegistry({ instances: [integration] });
  let ready = true;
  const requireRegistry = () => {
    if (!ready) throw new DomainError('EXECUTOR_UNAVAILABLE', 'Executor is offline', 503);
    return registry;
  };
  const directory = new AgentDirectory(registry, {
    knownIntegration: ({ agentId }) => registry.get(agentId),
    requireIntegration: ({ agentId }) => requireRegistry().require(agentId),
    integrationsFor: requireRegistry,
    isReady: () => ready,
  });
  const service = new AgentCatalogService({ directory, endpointResolver: { getModelOptions: () => [] } });
  const route = createModelsRoutes({
    modelCatalog: {
      agents: {
        getAgentCatalogEntry: service.getAgentCatalogEntry.bind(service),
        getAgentCatalogEntries: service.getAgentCatalogEntries.bind(service),
        requiresStrictModelDiscovery: service.requiresStrictModelDiscovery.bind(service),
        assertAgentAvailable: (agentId, id) => {
          if (!directory.list(id).some(item => item.descriptor.id === agentId)) throw new Error('Unknown agent');
        },
      },
      apiProviders: { getCatalog: () => [] },
    },
    responseCache: new ModelCatalogResponseCache(),
  })['/api/v1/models'].GET;
  const url = new URL(`http://localhost/api/v1/models?agent=test&executorId=${executorId}`);
  const models = [{ value: 'synthetic-model', label: 'Synthetic model' }];
  const snapshot = { models, defaultModel: models[0].value, requiresStrictModelDiscovery: true, generation: null };
  integration.catalog.snapshot = mock(async () => snapshot);
  return { integration, models, snapshot, request: () => route(new Request(url), url), offline: () => { ready = false; } };
}

describe('selected-agent discovery with the catalog service', () => {
  it('retains learned strict discovery and stale models after a non-strict RPC failure', async () => {
    const fixture = discoveryFixture();
    expect((await fixture.request()).status).toBe(200);
    const calls = [];
    fixture.integration.catalog.snapshot.mockImplementation(async ({ strict }) => {
      calls.push(strict);
      if (!strict) throw new Error('Synthetic RPC failure');
      throw Object.assign(new Error('Synthetic discovery failure'), { staleModels: fixture.models });
    });
    const response = await fixture.request();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: 'Model discovery unavailable', catalog: { agents: [{ models: fixture.models }] },
    });
    expect(calls).toEqual([false, true]);
  });

  it.each(['before', 'during'])('rejects a retained integration that goes offline %s discovery', async timing => {
    const fixture = discoveryFixture();
    expect((await fixture.request()).status).toBe(200);
    if (timing === 'before') fixture.offline();
    else fixture.integration.catalog.snapshot.mockImplementation(async () => {
      fixture.offline();
      throw new Error('Synthetic link loss');
    });
    const response = await fixture.request();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ errorCode: 'EXECUTOR_UNAVAILABLE' });
  });

  it.each(['success', 'failure'])('rejects executor loss during strict discovery even on %s', async outcome => {
    const fixture = discoveryFixture();
    fixture.integration.catalog.snapshot.mockImplementation(async ({ strict }) => {
      if (strict) {
        fixture.offline();
        if (outcome === 'failure') throw new DomainError('EXECUTOR_UNAVAILABLE', 'Synthetic link loss', 503);
      }
      return fixture.snapshot;
    });
    const response = await fixture.request();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ errorCode: 'EXECUTOR_UNAVAILABLE' });
  });
});

describe("GET /api/v1/models", () => {
  it('preserves invalid-executor and offline-executor HTTP errors', async () => {
    const invalid = new URL('http://localhost/api/v1/models?executorId=invalid');
    expect((await handler(new Request(invalid), invalid)).status).toBe(400);
    for (const query of ['', '&agent=codex']) {
      responseCache.clear();
      const queryCatalog = query ? modelCatalog.agents.getAgentCatalogEntry : modelCatalog.agents.getAgentCatalogEntries;
      queryCatalog.mockRejectedValueOnce(new DomainError('EXECUTOR_UNAVAILABLE', 'Executor is offline', 503));
      const url = new URL(`http://localhost/api/v1/models?executorId=22222222-2222-4222-8222-222222222222${query}`);
      const response = await handler(new Request(url), url);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ errorCode: 'EXECUTOR_UNAVAILABLE' });
    }
  });
  beforeEach(() => {
    responseCache.clear();
    modelCatalog.agents.getAgentCatalogEntries.mockClear();
    modelCatalog.agents.getAgentCatalogEntry.mockClear();
    modelCatalog.agents.assertAgentAvailable.mockClear();
    modelCatalog.agents.requiresStrictModelDiscovery.mockClear();
    modelCatalog.apiProviders.getCatalog.mockClear();
  });

  it("returns only the agent/API provider catalog", async () => {
    const url = new URL('http://localhost/api/v1/models');
    const response = await handler(new Request(url), url);
    const body = await response.json();

    expect(response.headers.get("etag")).toMatch(/^W\/"model-catalog:/);
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(Object.keys(body)).toEqual(["catalog"]);
    expect(Array.isArray(body.catalog.agents)).toBe(true);
    expect(Array.isArray(body.catalog.apiProviders)).toBe(true);
    expect(body.catalog.agents[0]).toMatchObject({
      supportedPermissionModes: ["default", "manualBypass"],
      supportedThinkingModes: ["none", "high"],
      settings: [],
      defaultSettings: { ownerId: "claude", schemaVersion: 1, values: {} },
    });
  });

  it("returns 304 when the model catalog etag matches", async () => {
    const url = new URL("http://localhost/api/v1/models");
    const first = await handler(new Request(url), url);
    const etag = first.headers.get("etag");

    const second = await handler(
      new Request(url, {
        headers: { "If-None-Match": etag },
      }),
      url,
    );

    expect(first.status).toBe(200);
    expect(etag).toMatch(/^W\/"model-catalog:/);
    expect(second.status).toBe(304);
    expect(second.headers.get("etag")).toBe(etag);
    expect(second.headers.get("cache-control")).toBe("private, no-cache");
    expect(await second.text()).toBe("");
  });

  it("reuses a fresh aggregate catalog snapshot across full catalog requests", async () => {
    const url = new URL("http://localhost/api/v1/models");

    await handler(new Request(url), url);
    await handler(new Request(url), url);

    expect(modelCatalog.agents.getAgentCatalogEntries).toHaveBeenCalledTimes(1);
  });

  it("changes the etag when model catalog content changes", async () => {
    modelCatalog.agents.getAgentCatalogEntries
      .mockResolvedValueOnce([
        {
          ...agentCatalogEntries[0],
          models: [{ value: "opus", label: "Opus" }],
        },
      ])
      .mockResolvedValueOnce([
        {
          ...agentCatalogEntries[0],
          models: [{ value: "sonnet", label: "Sonnet" }],
        },
      ]);

    const url = new URL("http://localhost/api/v1/models");
    const first = await handler(new Request(url), url);
    responseCache.clear();
    const second = await handler(new Request(url), url);

    expect(first.headers.get("etag")).not.toBe(second.headers.get("etag"));
  });

  it("keeps the etag stable when catalog ordering changes", async () => {
    modelCatalog.agents.getAgentCatalogEntries
      .mockResolvedValueOnce([
        {
          ...agentCatalogEntries[0],
          models: [
            { value: "sonnet", label: "Sonnet" },
            { value: "opus", label: "Opus" },
          ],
        },
        {
          ...agentCatalogEntries[1],
          models: [
            { value: "gpt-5.6-luna", label: "GPT-5.6-Luna" },
            { value: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
          ],
        },
      ])
      .mockResolvedValueOnce([
        {
          ...agentCatalogEntries[1],
          models: [
            { value: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
            { value: "gpt-5.6-luna", label: "GPT-5.6-Luna" },
          ],
        },
        {
          ...agentCatalogEntries[0],
          models: [
            { value: "opus", label: "Opus" },
            { value: "sonnet", label: "Sonnet" },
          ],
        },
      ]);

    const url = new URL("http://localhost/api/v1/models");
    const first = await handler(new Request(url), url);
    responseCache.clear();
    const second = await handler(new Request(url), url);

    expect(first.headers.get("etag")).toBe(second.headers.get("etag"));
  });

  it("returns catalog.agents with capability metadata", async () => {
    const url = new URL('http://localhost/api/v1/models');
    const response = await handler(new Request(url), url);
    const body = await response.json();

    expect(body.catalog).toBeDefined();
    expect(Array.isArray(body.catalog.agents)).toBe(true);
    expect(body.catalog.agents.length).toBe(9);

    const claude = body.catalog.agents.find((p) => p.id === "claude");
    expect(claude.supportsFork).toBe(true);
    expect(claude.supportsForkAtMessage).toBe(true);
    expect(claude.supportsForkWhileRunning).toBe(true);
    expect(claude.supportsSteering).toBe(false);
    expect(claude.supportsUpdateProjectPath).toBe(true);
    expect(claude.supportsImages).toBe(true);
    expect(Array.isArray(claude.models)).toBe(true);
    expect(claude.defaultModel).toBe("opus");

    const codex = body.catalog.agents.find((p) => p.id === "codex");
    expect(codex.supportsFork).toBe(true);
    expect(codex.supportsForkAtMessage).toBe(true);
    expect(codex.supportsForkWhileRunning).toBe(true);
    expect(codex.supportsSteering).toBe(true);
    expect(codex).not.toHaveProperty('supportsGoals');
    expect(codex.supportsUpdateProjectPath).toBe(true);
    expect(codex.supportsImages).toBe(true);
    expect(codex.defaultModel).toBe("gpt-5.5");
    expect(codex.models[0]).toEqual({
      value: "gpt-5.5",
      label: "GPT-5.5",
      supportsImages: true,
    });
    const codexModelValues = codex.models.map((model) => model.value);
    expect(codexModelValues).toEqual([
      "gpt-5.5",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.4",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
    ]);
    expect(
      codex.models.find((model) => model.value === "gpt-5.5"),
    ).toMatchObject({ supportsImages: true });
    expect(
      codex.models.find((model) => model.value === "gpt-6-astra"),
    ).toMatchObject({ supportsImages: true });
    expect(
      codex.models.find((model) => model.value === "gpt-5.6-sol"),
    ).toMatchObject({ supportsImages: true });
    expect(
      codex.models.find((model) => model.value === "gpt-5.6-terra"),
    ).toMatchObject({ supportsImages: true });
    expect(
      codex.models.find((model) => model.value === "gpt-5.6-luna"),
    ).toMatchObject({ supportsImages: true });
    expect(
      codex.models.find((model) => model.value === "gpt-5.4"),
    ).toMatchObject({ supportsImages: true });
    expect(
      codex.models.find((model) => model.value === "gpt-5.3-codex"),
    ).toMatchObject({ supportsImages: true });
    expect(
      codex.models.find((model) => model.value === "gpt-5.3-codex-spark"),
    ).toMatchObject({ supportsImages: false });
    expect(codexModelValues).not.toContain("gpt-5.2");
    expect(codexModelValues).not.toContain("gpt-5.2-codex");
    expect(codexModelValues).not.toContain("gpt-5.1-codex-max");
    expect(codexModelValues).not.toContain("gpt-5.1-codex-mini");

    const opencode = body.catalog.agents.find((p) => p.id === "opencode");
    expect(opencode.supportsFork).toBe(true);
    expect(opencode.supportsForkAtMessage).toBe(false);
    expect(opencode.supportsForkWhileRunning).toBe(false);
    expect(opencode.supportsUpdateProjectPath).toBe(true);
    expect(opencode.supportsImages).toBe(false);

    const factory = body.catalog.agents.find((p) => p.id === "factory");
    expect(factory.supportsFork).toBe(false);
    expect(factory.supportsForkAtMessage).toBe(false);
    expect(factory.supportsUpdateProjectPath).toBe(false);
    expect(factory.supportsImages).toBe(false);
    expect(Array.isArray(factory.models)).toBe(true);
    expect(factory.defaultModel).toBe("claude-opus-4-6");
    const factoryModelValues = factory.models.map((model) => model.value);
    expect(factoryModelValues).not.toContain("gpt-5.2");
    expect(factoryModelValues).not.toContain("gpt-5.2-codex");
    expect(factoryModelValues).not.toContain("gpt-5.1-codex-max");

    const pi = body.catalog.agents.find((p) => p.id === "pi");
    expect(pi.label).toBe("Pi");
    expect(pi.supportsFork).toBe(true);
    expect(pi.supportsForkAtMessage).toBe(false);
    expect(pi.supportsUpdateProjectPath).toBe(true);
    expect(pi.supportsImages).toBe(false);
    expect(pi.acceptsApiProviderEndpoints).toBe(false);
    expect(pi.supportedProtocols).toEqual([]);
    expect(pi.defaultModel).toBe("github-copilot/gpt-5.4");
    expect(pi.models).toContainEqual({
      value: "github-copilot/gpt-5.4",
      label: "github-copilot: gpt-5.4",
      supportsImages: true,
    });

    const directOpenAi = body.catalog.agents.find(
      (p) => p.id === "direct-openai-compatible",
    );
    expect(directOpenAi.label).toBe("Direct (Chat Completions)");
    expect(directOpenAi.supportsFork).toBe(true);
    expect(directOpenAi.supportsForkAtMessage).toBe(true);
    expect(directOpenAi.supportsForkWhileRunning).toBe(false);
    expect(directOpenAi.supportsUpdateProjectPath).toBe(true);
    expect(directOpenAi.supportsImages).toBe(true);
    expect(directOpenAi.supportedProtocols).toEqual(["openai-compatible"]);

    const directOpenAiResponses = body.catalog.agents.find(
      (p) => p.id === "direct-openai-responses-compatible",
    );
    expect(directOpenAiResponses.label).toBe("Direct (Responses)");
    expect(directOpenAiResponses.supportsFork).toBe(true);
    expect(directOpenAiResponses.supportsForkAtMessage).toBe(true);
    expect(directOpenAiResponses.supportsForkWhileRunning).toBe(false);
    expect(directOpenAiResponses.supportsUpdateProjectPath).toBe(true);
    expect(directOpenAiResponses.supportsImages).toBe(true);
    expect(directOpenAiResponses.supportedProtocols).toEqual([
      "openai-compatible",
    ]);

    const directAnthropic = body.catalog.agents.find(
      (p) => p.id === "direct-anthropic-compatible",
    );
    expect(directAnthropic.label).toBe("Direct (Anthropic)");
    expect(directAnthropic.supportsFork).toBe(true);
    expect(directAnthropic.supportsForkAtMessage).toBe(true);
    expect(directAnthropic.supportsForkWhileRunning).toBe(false);
    expect(directAnthropic.supportsUpdateProjectPath).toBe(true);
    expect(directAnthropic.supportsImages).toBe(true);
    expect(directAnthropic.supportedProtocols).toEqual(["anthropic-messages"]);

    expect(body.catalog.agents.find((p) => p.id === "zai")).toBeUndefined();
  });

  it("filters the catalog when agent param is given", async () => {
    const url = new URL("http://localhost/api/v1/models?agent=claude");
    const response = await handler(new Request(url), url);
    const body = await response.json();

    expect(body.catalog.agents.length).toBe(1);
    expect(body.catalog.agents[0].id).toBe("claude");
    expect(modelCatalog.agents.getAgentCatalogEntries).not.toHaveBeenCalled();
    expect(modelCatalog.agents.getAgentCatalogEntry).toHaveBeenCalledTimes(1);
    expect(modelCatalog.agents.getAgentCatalogEntry).toHaveBeenCalledWith('claude', { executorId: 'local' });
  });

  it('scopes selected-agent discovery and custom providers to the requested executor', async () => {
    const executorId = '22222222-2222-4222-8222-222222222222';
    const providers = [{ id: 'synthetic-provider', label: 'Synthetic provider', endpoints: [] }];
    modelCatalog.apiProviders.getCatalog.mockReturnValueOnce(providers);
    const url = new URL(`http://localhost/api/v1/models?agent=direct-openai-compatible&executorId=${executorId}`);
    const response = await handler(new Request(url), url);
    expect(response.status).toBe(200);
    expect((await response.json()).catalog.apiProviders).toEqual(providers);
    expect(modelCatalog.agents.getAgentCatalogEntry).toHaveBeenCalledTimes(1);
    expect(modelCatalog.agents.getAgentCatalogEntry).toHaveBeenCalledWith('direct-openai-compatible', { executorId });
    expect(modelCatalog.agents.getAgentCatalogEntries).not.toHaveBeenCalled();
    expect(modelCatalog.apiProviders.getCatalog).toHaveBeenCalledWith(executorId);
  });

  it("lists available agents when an agent filter is unknown", async () => {
    const url = new URL("http://localhost/api/v1/models?agent=unknown");
    const response = await handler(new Request(url), url);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("Available agents: claude");
    expect(body.error).toContain("codex");
  });

  it("uses the first selected snapshot to discover strict Pi policy without querying other agents", async () => {
    modelCatalog.agents.getAgentCatalogEntry
      .mockResolvedValueOnce(agentCatalogEntries.find((agent) => agent.id === 'pi'))
      .mockResolvedValueOnce({
      ...agentCatalogEntries.find((agent) => agent.id === "pi"),
      defaultModel: "openrouter/openai/gpt-5.4",
      models: [
        {
          value: "openrouter/openai/gpt-5.4",
          label: "openrouter: gpt-5.4",
          supportsImages: true,
        },
      ],
    });
    const url = new URL("http://localhost/api/v1/models?agent=pi");
    const response = await handler(new Request(url), url);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(modelCatalog.agents.getAgentCatalogEntries).not.toHaveBeenCalled();
    expect(modelCatalog.agents.getAgentCatalogEntry).toHaveBeenCalledTimes(2);
    expect(modelCatalog.agents.getAgentCatalogEntry).toHaveBeenCalledWith(
      "pi",
      { strict: true, executorId: 'local' },
    );
    expect(body.catalog.agents).toHaveLength(1);
    expect(body.catalog.agents[0].id).toBe("pi");
    expect(body.catalog.agents[0].models).toEqual([
      {
        value: "openrouter/openai/gpt-5.4",
        label: "openrouter: gpt-5.4",
        supportsImages: true,
      },
    ]);
  });

  it("returns a 503 when strict model discovery has no stale models", async () => {
    const error = Object.assign(
      new Error("auth storage: auth.json is locked"),
      {
        code: "PI_MODEL_DISCOVERY_UNAVAILABLE",
        staleModels: [],
      },
    );
    modelCatalog.agents.getAgentCatalogEntry
      .mockResolvedValueOnce(agentCatalogEntries.find((agent) => agent.id === 'pi'))
      .mockRejectedValueOnce(error);
    const url = new URL("http://localhost/api/v1/models?agent=pi");
    const response = await handler(new Request(url), url);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: "Model discovery unavailable",
      reason: "auth storage: auth.json is locked",
    });
  });

  it("returns stale Pi models in the 503 body when available", async () => {
    const staleModels = [
      {
        value: "openrouter/openai/gpt-5.4",
        label: "openrouter: gpt-5.4",
        supportsImages: true,
      },
    ];
    const error = Object.assign(
      new Error("auth storage: auth.json is locked"),
      {
        code: "PI_MODEL_DISCOVERY_UNAVAILABLE",
        staleModels,
      },
    );
    modelCatalog.agents.getAgentCatalogEntry
      .mockResolvedValueOnce(agentCatalogEntries.find((agent) => agent.id === 'pi'))
      .mockRejectedValueOnce(error);
    const url = new URL("http://localhost/api/v1/models?agent=pi");
    const response = await handler(new Request(url), url);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toBe("Model discovery unavailable");
    expect(body.catalog.agents).toHaveLength(1);
    expect(body.catalog.agents[0].id).toBe("pi");
    expect(body.catalog.agents[0].models).toEqual(staleModels);
  });
});
