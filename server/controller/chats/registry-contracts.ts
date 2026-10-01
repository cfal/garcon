import type { PermissionMode, ThinkingMode } from '../../../common/chat-modes.js';
import type { AgentSettingsEnvelope } from '../../../common/agent-integration.js';
import type { ApiProtocol } from '../../../common/api-providers.js';
import type { ParentChatRef } from '../../../common/chat-parentage.js';
import type { AgentNativeSessionRef } from '@garcon/server-agent-interface';
import type { AgentName } from '../agents/session-types.js';
import type { NativeSeedReceipt } from '../../../common/transcript-seed.js';
import type { ChatPreambleSelection, PendingPreambleBoundary } from '../../../common/preambles.js';


export const CHAT_REGISTRY_VERSION = 5;

export interface CarryOverMigrationQuarantine {
  artifactId: string;
  errorCode: string;
}

export interface CarryOverHandoffTarget {
  readonly agentId: AgentName;
  readonly model: string;
}

export interface CarryOverSegmentRef {
  readonly id: string;
  readonly agentId: AgentName;
  readonly model: string;
  readonly capturedAt: string;
  readonly storedMessageCount: number;
  readonly visibleMessageCount: number;
  readonly trailingHandoff: CarryOverHandoffTarget | null;
}

export interface ChatRegistryEntry {
  executorId?: string | null;
  agentId: AgentName;
  nativeSession: AgentNativeSessionRef | null;
  agentOwnershipEpoch: string;
  agentSettingsById: Record<string, AgentSettingsEnvelope>;
  projectPath: string;
  tags: string[];
  agentSessionId: string | null;
  model: string;
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  modelProtocol?: ApiProtocol | null;
  lastReadAt?: string | null;
  permissionMode: PermissionMode;
  thinkingMode: ThinkingMode;
  carryOverSegments: readonly CarryOverSegmentRef[];
  nativeSeedReceipt: NativeSeedReceipt | null;
  carryOverMigrationQuarantine: CarryOverMigrationQuarantine | null;
  pendingPreambleBoundary: PendingPreambleBoundary | null;
  // Required normalized per-chat preamble selection; chats.json is authoritative.
  preambleSelection: ChatPreambleSelection;
  readonly parentChat: ParentChatRef | null;
}

export interface ChatRegistrySnapshot {
  version: number;
  sessions: Record<string, ChatRegistryEntry>;
}
