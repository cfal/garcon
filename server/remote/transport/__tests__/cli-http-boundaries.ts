import type * as Commands from '@garcon/common/chat-command-contracts';
import type * as Schedules from '@garcon/common/scheduled-prompts';
import type * as Executors from '@garcon/common/executors';
import type * as Tickets from '@garcon/common/tickets';
import type { CLI_OPERATIONS } from '@garcon/common/cli-contracts';
import type { ApiProviderManagement } from '@garcon/common/api-providers';
import type { ModelCatalogResponse } from '@garcon/common/model-catalog';
import type { RemoteSettingsSnapshot } from '@garcon/common/settings';
import type { PreamblesSnapshot } from '@garcon/common/preambles';
import type { ChatListResponse } from '@garcon/common/chat-list';
import type { ChatHistoryResponse, ChatMessagesRequest } from '@garcon/common/chat-view';
import type { ChatSnapshotResponse } from '@garcon/common/chat-snapshot';
import type { AgentTurnReceipt } from '@garcon/common/agent-turn-receipt';
import type { TranscriptExportResponse, TranscriptExportFormat, TranscriptExportCategory } from '@garcon/common/chat-export-contracts';
import type { ChatHandoffArtifactResponse } from '@garcon/common/chat-handoff-artifact-contracts';
import type { NativeSessionLookupRequest, NativeSessionLookupResponse } from '@garcon/common/native-session-lookup';
import type { ChatSearchRequest, ChatSearchResponse, TranscriptSearchStatusResponse, TranscriptSearchRebuildResponse } from '@garcon/common/chat-search';
import type { ChatRowTargetResponse, AddChatRowRequest, AddChatRowResponse } from '@garcon/common/chat-row-contracts';
import type { UpdateChatTitleRequest, UpdateChatTitleResponse } from '@garcon/common/chat-title-contracts';
import type { SetChatArchivedRequest, SetChatPinnedRequest, SetChatOrderStateResponse } from '@garcon/common/chat-order-contracts';
import type { RecoverChatTagsResponse } from '@garcon/common/chat-tag-mutations';
import type { SetChatTagsRequest, SetChatTagsResponse } from '@garcon/common/chat-tags-contracts';
import type { HttpTicketMutationRequest } from '@garcon/common/ticket-commands';

type Http<Request, Result> = { readonly request: Request; readonly result: Result };
type WithExecutor<T> = Omit<T, 'executorId'> & { readonly executorId: string };
type ScheduleRequest<T> = Omit<T, 'scheduledPrompt'> & {
  readonly scheduledPrompt: Omit<Schedules.ScheduledPromptDefinitionInput, 'target'> & {
    readonly target: WithExecutor<Schedules.NewChatScheduledPromptTarget> | Schedules.ExistingChatScheduledPromptTarget;
  };
};
type ExecutorPath = { readonly executorId: string };
type ChatQuery = { readonly chatId: string };
type AssignmentQuery = { readonly executorId: string; readonly apiProviderId: string };
type ExecutorList = { readonly executors: readonly Executors.ExecutorSnapshot[] };

// Describes HTTP bodies and encoded query/path fields, not the client's unwrapped return values.
export interface CliHttpBoundariesV1 {
  'cli.schedules.list': Http<null, Schedules.ScheduledPromptsSnapshot>;
  'cli.schedules.create': Http<{ body: ScheduleRequest<Schedules.CreateScheduledPromptRequest> }, Schedules.CreateScheduledPromptResponse>;
  'cli.schedules.update': Http<{ body: ScheduleRequest<Schedules.UpdateScheduledPromptRequest> }, Schedules.ScheduledPromptsMutationResponse>;
  'cli.schedules.delete': Http<{ body: Schedules.RemoveScheduledPromptRequest }, Schedules.ScheduledPromptsMutationResponse>;
  'cli.schedules.enabled': Http<{ body: Schedules.SetScheduledPromptEnabledRequest }, Schedules.ScheduledPromptsMutationResponse>;
  'cli.executors.list': Http<null, ExecutorList>;
  'cli.executors.create': Http<{ body: Executors.CreateExecutorRequest }, { id: string } & Executors.ExecutorConnection>;
  'cli.executors.update': Http<{ path: ExecutorPath; body: Executors.UpdateExecutorRequest }, ExecutorList>;
  'cli.executors.delete': Http<{ path: ExecutorPath }, ExecutorList>;
  'cli.executors.connection': Http<{ path: ExecutorPath }, Executors.ExecutorConnection>;
  'cli.providers.assignments': Http<null, ApiProviderManagement>;
  'cli.providers.assign': Http<{ query: AssignmentQuery }, ApiProviderManagement>;
  'cli.providers.unassign': Http<{ query: AssignmentQuery }, ApiProviderManagement>;
  'cli.models.list': Http<{ query: { agent?: string; executorId: string } }, ModelCatalogResponse>;
  'cli.settings.read': Http<null, RemoteSettingsSnapshot>;
  'cli.preambles.list': Http<null, PreamblesSnapshot>;
  'cli.chats.list': Http<null, ChatListResponse>;
  'cli.chats.messages': Http<{ query: ChatQuery & { limit?: string; beforeOrdinal?: string; transcriptViewId?: string; purpose?: ChatMessagesRequest['purpose'] } }, ChatHistoryResponse>;
  'cli.chats.snapshot': Http<{ query: ChatQuery & { limit: string } }, ChatSnapshotResponse>;
  'cli.chats.turnReceipt': Http<{ query: ChatQuery & { turnId: string } }, AgentTurnReceipt>;
  'cli.chats.export': Http<{ query: ChatQuery & { format: TranscriptExportFormat; exclude?: readonly TranscriptExportCategory[] } }, TranscriptExportResponse>;
  'cli.chats.handoffArtifact': Http<{ query: ChatQuery & { contextWindowTokens: string } }, ChatHandoffArtifactResponse>;
  'cli.chats.lookupNativeSession': Http<{ body: WithExecutor<NativeSessionLookupRequest> }, NativeSessionLookupResponse>;
  'cli.chats.search': Http<{ body: ChatSearchRequest }, ChatSearchResponse>;
  'cli.chats.searchStatus': Http<null, TranscriptSearchStatusResponse>;
  'cli.chats.rebuildSearch': Http<null, TranscriptSearchRebuildResponse>;
  'cli.settings.updateSearch': Http<{ body: { features: { transcriptSearch: { enabled: boolean } } } }, { success: true; settings: RemoteSettingsSnapshot }>;
  'cli.chats.start': Http<{ body: WithExecutor<Commands.StartChatCommandRequest> }, Commands.StartChatCommandResponse>;
  'cli.chats.run': Http<{ body: Commands.AgentRunCommandRequest }, Commands.AgentTurnCommandResponse>;
  'cli.chats.fork': Http<{ body: Commands.ForkChatCommandRequest }, Commands.ForkChatResponse>;
  'cli.chats.forkRun': Http<{ body: Commands.ForkRunCommandRequest }, Commands.ForkRunCommandResponse>;
  'cli.chats.steer': Http<{ body: Commands.SteerCommandRequest }, Commands.SteerCommandResponse>;
  'cli.chats.stop': Http<{ body: Commands.AgentStopCommandRequest }, Commands.AgentStopResponse>;
  'cli.chats.permissionDecision': Http<{ body: Commands.PermissionDecisionCommandRequest }, Commands.CommandAcceptedResponse>;
  'cli.chats.rows': Http<{ query: ChatQuery }, ChatRowTargetResponse>;
  'cli.chats.addRow': Http<{ body: AddChatRowRequest }, AddChatRowResponse>;
  'cli.chats.rename': Http<{ body: UpdateChatTitleRequest }, UpdateChatTitleResponse>;
  'cli.chats.pin': Http<{ body: SetChatPinnedRequest }, SetChatOrderStateResponse>;
  'cli.chats.archive': Http<{ body: SetChatArchivedRequest }, SetChatOrderStateResponse>;
  'cli.chats.tags': Http<{ query: ChatQuery }, RecoverChatTagsResponse>;
  'cli.chats.setTags': Http<{ body: SetChatTagsRequest }, SetChatTagsResponse>;
  'cli.tickets.bootstrap': Http<null, Tickets.TicketBootstrap>;
  'cli.tickets.list': Http<{ query: {
    project?: string; status?: Tickets.TicketStatus; includeClosed?: 'true' | 'false'; priority?: string;
    label?: string; assignee?: string; ready?: 'true' | 'false'; query?: string; beforeNumber?: string;
    expectedCollectionRevision?: string; limit?: string;
  } }, Tickets.TicketPage>;
  'cli.tickets.detail': Http<{ query: {
    ticketId: string; includeDescription?: 'true' | 'false'; commentLimit?: string;
    beforeCommentSequence?: string; expectedCollectionRevision?: string;
  } }, Tickets.TicketDetail>;
  'cli.tickets.history': Http<{ query: { ticketId: string; limit?: string; beforeSequence?: string } }, Tickets.TicketSequencePage<Tickets.TicketActivity>>;
  'cli.tickets.projectDefault': Http<{ body: WithExecutor<{ directory: string }> }, Tickets.TicketProjectDefault>;
  'cli.tickets.mutate': Http<{ body: HttpTicketMutationRequest }, Tickets.TicketWriteResult>;
}

type OperationName = (typeof CLI_OPERATIONS)[keyof typeof CLI_OPERATIONS][1]['name'];
type AssertNever<T extends never> = T;
export type MissingBoundary = AssertNever<Exclude<OperationName, keyof CliHttpBoundariesV1>>;
export type UndeclaredBoundary = AssertNever<Exclude<keyof CliHttpBoundariesV1, OperationName>>;
