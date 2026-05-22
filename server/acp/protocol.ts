export interface AcpJsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface AcpJsonRpcMessage {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: AcpJsonRpcError;
}

export interface AcpInitializeParams {
  protocolVersion: number;
  clientInfo?: { name: string; version: string };
  clientCapabilities?: {
    fs?: { readTextFile?: boolean; writeTextFile?: boolean };
    terminal?: boolean;
  };
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

export interface AcpSessionNewResult {
  sessionId: string;
  modes?: unknown;
  models?: unknown;
  configOptions?: unknown[];
}

export interface AcpSessionPromptResult {
  stopReason?: string;
  requestId?: string;
}

export interface AcpSessionLoadResult {
  modes?: unknown;
  models?: unknown;
  configOptions?: unknown[];
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
