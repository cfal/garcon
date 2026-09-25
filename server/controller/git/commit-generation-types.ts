import type { AgentId } from '../../../common/agents.js';
import type { ApiProtocol } from '../../../common/api-providers.js';
import type { ThinkingMode } from '../../../common/chat-modes.js';
import type { ProjectOptions } from '../../runtime/git/types.js';

export interface CommitMessageOptions {
  executorId?: string | null;
  model?: string;
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  modelProtocol?: ApiProtocol | null;
  thinkingMode?: ThinkingMode;
  timeoutMs?: number;
  signal?: AbortSignal;
  customPrompt?: string;
}

export interface RunSingleQueryOptions extends CommitMessageOptions {
  [key: string]: unknown;
  agentId: AgentId;
}

export interface GitAgentRunner {
  runSingleQuery(prompt: string, options: RunSingleQueryOptions): Promise<string>;
}

export interface CommitMessageFileOptions extends ProjectOptions, CommitMessageOptions {
  files: string[];
  agentId: AgentId;
  useCommonDirPrefix?: boolean;
}
