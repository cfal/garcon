// Shared agent contracts. Agents execute chats; API providers expose
// compatible endpoint configurations that some agents may consume.

import type { ApiProviderCatalogEntry, ApiProtocol } from "./api-providers.js";
import type {
  AgentSettingDescriptor,
  AgentSettingsEnvelope,
} from "./agent-integration.js";
import type { PermissionMode, ThinkingMode } from "./chat-modes.js";

export const DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID =
  "direct-openai-compatible" as const;
export const DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID =
  "direct-openai-responses-compatible" as const;
export const DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID =
  "direct-anthropic-compatible" as const;
export const DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_LABEL =
  "Direct (Chat Completions)" as const;
export const DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_LABEL =
  "Direct (Responses)" as const;
export const DIRECT_ANTHROPIC_COMPATIBLE_AGENT_LABEL =
  "Direct (Anthropic)" as const;
export const DEFAULT_AGENT_ID = "claude" as const;

export type AgentId = string & {};

export interface AgentModelOption {
  value: string;
  label: string;
  supportsImages?: boolean;
  isLocal?: boolean;
  apiProviderId?: string;
  endpointId?: string;
  rawModel?: string;
  protocol?: ApiProtocol;
}

export interface AgentCatalogEntry {
  id: AgentId;
  label: string;
  description?: string;
  kind: "agent";
  supportsFork: boolean;
  supportsForkAtMessage: boolean;
  supportsForkAtMessageWhileRunning: boolean;
  supportsUpdateProjectPath: boolean;
  supportsImages: boolean;
  acceptsApiProviderEndpoints: boolean;
  supportedProtocols: ApiProtocol[];
  authLoginSupported: boolean;
  supportedPermissionModes: PermissionMode[];
  supportedThinkingModes: ThinkingMode[];
  settings: AgentSettingDescriptor[];
  defaultSettings: AgentSettingsEnvelope;
  requiresStrictModelDiscovery: boolean;
  generation: { priority: number; model: string } | null;
  defaultModel: string;
  models: AgentModelOption[];
}

export interface AgentCatalog {
  agents: AgentCatalogEntry[];
  apiProviders: ApiProviderCatalogEntry[];
}

const SAFE_ID_RE = /^[a-z][a-z0-9_-]{1,63}$/;

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && SAFE_ID_RE.test(value);
}
