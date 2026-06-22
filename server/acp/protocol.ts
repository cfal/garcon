export interface AcpJsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type AcpJsonRpcId = number | string;

export interface AcpClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AcpJsonRpcMessage {
  jsonrpc: '2.0';
  id?: AcpJsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: AcpJsonRpcError;
}

export interface AcpInitializeParams {
  protocolVersion: number;
  clientInfo?: { name: string; version: string };
  clientCapabilities?: AcpClientCapabilities;
  mcpServers?: unknown[];
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities?: {
    loadSession?: boolean;
    sessionCapabilities?: Record<string, unknown>;
    mcpCapabilities?: Record<string, unknown>;
    promptCapabilities?: Record<string, unknown>;
  };
  authMethods?: Array<{ id: string; name?: string; description?: string }>;
}

export interface AcpSessionConfigOptionValue {
  value: string;
  name?: string;
  description?: string;
  [key: string]: unknown;
}

export interface AcpSessionConfigOption {
  id: string;
  name?: string;
  description?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: AcpSessionConfigOptionValue[];
  [key: string]: unknown;
}

export interface AcpSessionConfigOptionsResult {
  configOptions?: AcpSessionConfigOption[];
}

export interface AcpSessionNewResult {
  sessionId: string;
  modes?: unknown;
  models?: unknown;
  configOptions?: AcpSessionConfigOption[];
}

export interface AcpSessionPromptResult {
  stopReason?: string;
  requestId?: string;
}

export interface AcpSessionLoadResult {
  modes?: unknown;
  models?: unknown;
  configOptions?: AcpSessionConfigOption[];
}

export interface AcpSessionRequestPermission {
  sessionId?: string;
  toolCall?: Record<string, unknown>;
  options?: Array<Record<string, unknown>>;
}

export interface AcpSessionUpdateNotification {
  sessionId?: string;
  update?: {
    sessionUpdate?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
