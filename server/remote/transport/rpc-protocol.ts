import type { AgentDescriptor, AgentSettingDescriptor, AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import type { FileRpcMethods } from './file-protocol.js';
import { isGitRpcMethod, type GitRpcMethods } from './git-protocol.js';
import type { TerminalRpcMethods } from './terminal-protocol.js';
import type { CliRpcMethods } from './cli-protocol.js';
import type {
  AgentExecutionHandle,
  AgentIntegration,
  AgentHost,
  AgentHistoryImportRequest,
  AgentImportedTranscriptRow,
  AgentProducerBinding,
  AgentProducerNotification,
  AgentResourceRef,
  AgentResourceScope,
  ExecutorInfo,
  ExecutionRuntimeApi,
  ExecutionProjectService,
} from '@garcon/server-agent-interface';

type Facet<K extends keyof AgentIntegration> = NonNullable<AgentIntegration[K]>;
type Request<F extends keyof AgentIntegration, M extends keyof Facet<F>> =
  Facet<F>[M] extends (request: infer R, ...args: never[]) => unknown ? R : never;
type Result<F extends keyof AgentIntegration, M extends keyof Facet<F>> =
  Facet<F>[M] extends (...args: never[]) => infer R ? Awaited<R> : never;
type WithoutSignal<T> = Omit<T, 'signal'>;
type Call<Q, R> = { readonly request: Q; readonly result: R };

// Revision of what the controller and worker exchange over an executor link:
// session framing, RPC methods and payloads, and producer, terminal, and CLI
// frames. Bump it with any change to what either side sends or accepts. Builds
// of one release share a package version, so without the bump a mismatched
// pair passes the handshake and fails mid-session instead.
export const EXECUTOR_PROTOCOL_REVISION = 3;

export const NULLABLE_AGENT_FACETS = [
  'auth', 'commands', 'compaction', 'forking', 'steering', 'endpoints', 'singleQuery',
  'legacyHistoryImport', 'nativeHistoryImport', 'nativeActivity', 'nativeSessions',
  'configurationValidation', 'sessionConfiguration', 'projectPathUpdates',
] as const satisfies readonly (keyof AgentIntegration)[];

export interface IntegrationManifest {
  readonly descriptor: AgentDescriptor;
  readonly scope: AgentResourceScope;
  readonly settings: {
    readonly descriptors: readonly AgentSettingDescriptor[];
    readonly defaults: AgentSettingsEnvelope;
  };
  readonly attachments: AgentIntegration['attachments'];
  readonly capabilities: Readonly<Record<typeof NULLABLE_AGENT_FACETS[number], boolean>>;
  readonly authMethods: { readonly launchLogin: boolean; readonly completeLogin: boolean; readonly loginStatus: boolean };
  readonly singleQueryRunsToolsWithoutPermission: boolean;
}

export type HistoryReaderRef = AgentResourceRef<'history-reader'>;

export interface ExecutorRpcMethods extends FileRpcMethods, TerminalRpcMethods, GitRpcMethods, CliRpcMethods {
  'executor.describe': Call<null, { readonly info: ExecutorInfo; readonly integrations: readonly IntegrationManifest[] }>;
  'apiProviders.discoverModels': Call<Parameters<ExecutionRuntimeApi['discoverApiProviderModels']>[0], Awaited<ReturnType<ExecutionRuntimeApi['discoverApiProviderModels']>>>;
  'projects.inspect': Call<Parameters<ExecutionProjectService['inspect']>[0], Awaited<ReturnType<ExecutionProjectService['inspect']>>>;
  'projects.ticketProjectDefault': Call<Parameters<ExecutionProjectService['ticketProjectDefault']>[0], Awaited<ReturnType<ExecutionProjectService['ticketProjectDefault']>>>;
  'projects.resolveFileMentions': Call<Parameters<ExecutionProjectService['resolveFileMentions']>[0], string>;
  'producers.bind': Call<Request<'producers', 'bind'>, void>;
  'producers.close': Call<Request<'producers', 'close'>, void>;
  // Cancels native admission of a launch whose call the controller lost.
  'producers.cancelLaunch': Call<{ readonly binding: AgentProducerBinding; readonly runId: string }, void>;
  // Reattaches bindings from a lost session; the worker resends their retained
  // frames after `acknowledgedSeq` and omits bindings it no longer holds.
  'producers.resume': Call<{
    readonly bindings: readonly { readonly binding: AgentProducerBinding; readonly acknowledgedSeq: number }[];
  }, { readonly resumed: readonly ProducerResumeState[] }>;
  'permissions.respond': Call<Request<'permissions', 'respond'>, void>;
  'execution.start': Call<Request<'execution', 'start'>, Result<'execution', 'start'>>;
  'execution.resume': Call<Request<'execution', 'resume'>, Result<'execution', 'resume'>>;
  'execution.abort': Call<Request<'execution', 'abort'>, boolean>;
  'execution.runningSessions': Call<null, Result<'execution', 'runningSessions'>>;
  'catalog.snapshot': Call<{ readonly strict: boolean }, Result<'catalog', 'snapshot'>>;
  'settings.migrate': Call<AgentSettingsEnvelope, AgentSettingsEnvelope>;
  'lifecycle.start': Call<null, void>;
  'lifecycle.stop': Call<null, void>;
  'lifecycle.migrateOwnedStorage': Call<null, void>;
  'migration.translateLegacyModel': Call<WithoutSignal<Request<'migration', 'translateLegacyModel'>>, string>;
  'migration.translateLegacyNativeSession': Call<WithoutSignal<Request<'migration', 'translateLegacyNativeSession'>>, Result<'migration', 'translateLegacyNativeSession'>>;
  'migration.translateLegacySettings': Call<WithoutSignal<Request<'migration', 'translateLegacySettings'>>, Result<'migration', 'translateLegacySettings'>>;
  'auth.status': Call<null, Result<'auth', 'status'>>;
  'auth.launchLogin': Call<null, Awaited<ReturnType<NonNullable<Facet<'auth'>['launchLogin']>>>>;
  'auth.completeLogin': Call<{ readonly sessionId: string; readonly code: string }, Awaited<ReturnType<NonNullable<Facet<'auth'>['completeLogin']>>>>;
  'auth.loginStatus': Call<{ readonly expectedSessionId?: string }, Awaited<ReturnType<NonNullable<Facet<'auth'>['loginStatus']>>>>;
  'commands.discover': Call<{ readonly projectPath: string }, Result<'commands', 'discover'>>;
  'compaction.compact': Call<Request<'compaction', 'compact'>, Result<'compaction', 'compact'>>;
  'forking.fork': Call<WithoutSignal<Request<'forking', 'fork'>>, Result<'forking', 'fork'>>;
  'forking.discard': Call<Request<'forking', 'discard'>, void>;
  'steering.captureTarget': Call<Request<'steering', 'captureTarget'>, Result<'steering', 'captureTarget'>>;
  'steering.steer': Call<Request<'steering', 'steer'>, Result<'steering', 'steer'>>;
  'endpoints.validate': Call<Request<'endpoints', 'validate'>, void>;
  'singleQuery.run': Call<WithoutSignal<Request<'singleQuery', 'run'>>, string>;
  'history.open': Call<{ readonly source: 'legacyHistoryImport' | 'nativeHistoryImport'; readonly request: WithoutSignal<AgentHistoryImportRequest> }, HistoryReaderRef>;
  // Pages are numbered from zero so a reader may keep several requests in flight.
  'history.next': Call<{ readonly reader: HistoryReaderRef; readonly page: number }, { readonly done: boolean; readonly rows: readonly AgentImportedTranscriptRow[] }>;
  'history.close': Call<HistoryReaderRef, void>;
  'nativeActivity.lastActivity': Call<Request<'nativeActivity', 'lastActivity'>, Result<'nativeActivity', 'lastActivity'>>;
  'nativeSessions.resolveNativeSession': Call<WithoutSignal<AgentHistoryImportRequest>, Result<'nativeSessions', 'resolveNativeSession'>>;
  'nativeSessions.describeSource': Call<WithoutSignal<AgentHistoryImportRequest>, Result<'nativeSessions', 'describeSource'>>;
  'nativeSessions.release': Call<WithoutSignal<Request<'nativeSessions', 'release'>>, void>;
  'configurationValidation.validate': Call<Request<'configurationValidation', 'validate'>, void>;
  'sessionConfiguration.apply': Call<{ readonly args: Parameters<Facet<'sessionConfiguration'>['apply']> }, void>;
  'projectPathUpdates.prepare': Call<Request<'projectPathUpdates', 'prepare'>, Result<'projectPathUpdates', 'prepare'>>;
  'projectPathUpdates.commit': Call<Request<'projectPathUpdates', 'commit'>, void>;
  'projectPathUpdates.rollback': Call<Request<'projectPathUpdates', 'rollback'>, void>;
  'credentials.resolve': Call<WithoutSignal<Parameters<AgentHost['apiProviders']['resolveCredential']>[0]>, Awaited<ReturnType<AgentHost['apiProviders']['resolveCredential']>>>;
  // Settles the journaled calls lost sessions left outstanding; see `RpcContinuity`.
  'calls.reconcile': Call<{ readonly calls: readonly OutstandingCall[] }, { readonly states: readonly OutstandingCallState[] }>;
}

export type ExecutorRpcRequest = {
  [K in keyof ExecutorRpcMethods]: {
    readonly type: 'request'; readonly id: string; readonly integrationId: string;
    // Numbers each session's requests from 1, so a worker can tell a request it
    // never received from one whose reply it no longer holds.
    readonly seq: number;
    readonly method: K; readonly request: ExecutorRpcMethods[K]['request'];
  }
}[keyof ExecutorRpcMethods];

// How a call relates to the session that carries it:
// - `session`: bound to that session. Losing the session cancels its handler,
//   and its caller sees an unknown outcome.
// - `launch`: a start, resume, or compaction. Its handler outlives the session,
//   and the producer relay reports its outcome.
// - `journaled`: its handler outlives the session, and the worker keeps its
//   reply until the controller acknowledges it. A controller parks the call
//   when the session is lost and reconciles it on the replacement session, so
//   its caller sees the real outcome.
export type RpcContinuity = 'session' | 'launch' | 'journaled';

type ClassifiedMethod = Exclude<keyof ExecutorRpcMethods, keyof FileRpcMethods | keyof GitRpcMethods>;

// History readers, terminal attachments, producer bindings, forks, path
// preparations, and CLI calls belong to one session. Compensation for a fork or
// preparation is issued on its session and is then journaled like other calls.
const CONTINUITY: Readonly<Record<ClassifiedMethod, RpcContinuity>> = {
  'executor.describe': 'session',
  'apiProviders.discoverModels': 'journaled',
  'projects.inspect': 'journaled',
  'projects.ticketProjectDefault': 'journaled',
  'projects.resolveFileMentions': 'journaled',
  'producers.bind': 'session',
  'producers.close': 'session',
  'producers.cancelLaunch': 'journaled',
  'producers.resume': 'session',
  'permissions.respond': 'journaled',
  'execution.start': 'launch',
  'execution.resume': 'launch',
  'execution.abort': 'journaled',
  'execution.runningSessions': 'journaled',
  'catalog.snapshot': 'journaled',
  'settings.migrate': 'journaled',
  'lifecycle.start': 'session',
  'lifecycle.stop': 'session',
  'lifecycle.migrateOwnedStorage': 'session',
  'migration.translateLegacyModel': 'journaled',
  'migration.translateLegacyNativeSession': 'journaled',
  'migration.translateLegacySettings': 'journaled',
  'auth.status': 'journaled',
  'auth.launchLogin': 'journaled',
  'auth.completeLogin': 'journaled',
  'auth.loginStatus': 'journaled',
  'commands.discover': 'journaled',
  'compaction.compact': 'launch',
  'forking.fork': 'session',
  'forking.discard': 'journaled',
  'steering.captureTarget': 'journaled',
  'steering.steer': 'journaled',
  'endpoints.validate': 'journaled',
  'singleQuery.run': 'journaled',
  'history.open': 'session',
  'history.next': 'session',
  'history.close': 'session',
  'nativeActivity.lastActivity': 'journaled',
  'nativeSessions.resolveNativeSession': 'journaled',
  'nativeSessions.describeSource': 'journaled',
  'nativeSessions.release': 'journaled',
  'configurationValidation.validate': 'journaled',
  'sessionConfiguration.apply': 'journaled',
  'projectPathUpdates.prepare': 'session',
  'projectPathUpdates.commit': 'journaled',
  'projectPathUpdates.rollback': 'journaled',
  'credentials.resolve': 'session',
  'calls.reconcile': 'session',
  'terminals.list': 'session',
  'terminals.create': 'session',
  'terminals.rename': 'session',
  'terminals.terminate': 'session',
  'terminals.attach': 'session',
  'terminals.input': 'session',
  'terminals.resize': 'session',
  'terminals.detach': 'session',
  'controllerCli.describe': 'session',
  'controllerCli.request': 'session',
};

// Calls that install a replacement session. They bypass the request budgets,
// so the calls a session recovers cannot keep it from installing.
export const SESSION_INSTALLATION_METHODS: ReadonlySet<string> = new Set<keyof ExecutorRpcMethods>([
  'executor.describe', 'lifecycle.migrateOwnedStorage', 'lifecycle.start', 'producers.resume', 'calls.reconcile',
]);

export function rpcContinuity(method: string): RpcContinuity {
  if (method.startsWith('files.') || isGitRpcMethod(method)) return 'journaled';
  return Object.hasOwn(CONTINUITY, method) ? CONTINUITY[method as ClassifiedMethod] : 'session';
}

// A journaled call a lost session left outstanding, named by where it was last sent.
export interface OutstandingCall {
  readonly id: string;
  readonly session: string;
  readonly seq: number;
}

// `pending`: the worker has or will have its reply, which it delivers on the
// session that asked. `not-received`: the request never arrived, so the
// controller sends it again. `unknown`: the worker kept no record of it.
export interface OutstandingCallState {
  readonly id: string;
  readonly state: 'pending' | 'not-received' | 'unknown';
}

// Controller-to-worker, fire-and-forget: releases the worker's copies of these
// journaled replies.
export interface ReplyAckFrame {
  readonly type: 'reply-ack';
  readonly ids: readonly string[];
}

export interface AgentProducerFrame {
  readonly type: 'producer';
  // Numbers each binding's notifications from 1. A skipped number means the
  // worker dropped retained output.
  readonly seq: number;
  readonly notification: AgentProducerNotification;
}

export interface ProducerAcknowledgement {
  readonly bindingId: string;
  readonly seq: number;
}

// What a resumed binding looked like on the worker when it replied: the last
// sequence number its replay delivers, its latest start, resume, or compaction
// until that run ends or the launch fails, and the runs of its latest launches
// the worker received. A null handle means the launch has not returned yet; its
// outcome follows on the binding.
export interface ProducerResumeState {
  readonly bindingId: string;
  readonly replayThroughSeq: number;
  readonly launch: { readonly runId: string; readonly handle: AgentExecutionHandle | null } | null;
  readonly receivedRunIds: readonly string[];
}

// Controller-to-worker, fire-and-forget: releases buffered frames through `seq`.
export interface ProducerAckFrame {
  readonly type: 'producer-ack';
  readonly acknowledgements: readonly ProducerAcknowledgement[];
}
