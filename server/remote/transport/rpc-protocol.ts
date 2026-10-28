import type { RpcContractDefinition } from '@garcon/common/executor-contracts';
import type { ContractRef } from '@garcon/common/protocol-contracts';
import type { AgentDescriptor, AgentSettingDescriptor, AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import type { FileRpcMethods } from './file-protocol.js';
import type { GitRpcMethods } from './git-protocol.js';
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
  AgentSessionConfiguration,
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

export const NULLABLE_AGENT_FACETS = [
  'readiness',
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
  readonly literalExecution: AgentIntegration['literalExecution'];
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
  'readiness.status': Call<null, Result<'readiness', 'status'>>;
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
  'sessionConfiguration.apply': Call<{
    readonly args: readonly [agentSessionId: string, configuration: AgentSessionConfiguration, previousConfiguration: AgentSessionConfiguration];
  }, void>;
  'projectPathUpdates.prepare': Call<Request<'projectPathUpdates', 'prepare'>, Result<'projectPathUpdates', 'prepare'>>;
  'projectPathUpdates.commit': Call<Request<'projectPathUpdates', 'commit'>, void>;
  'projectPathUpdates.rollback': Call<Request<'projectPathUpdates', 'rollback'>, void>;
  'credentials.resolve': Call<WithoutSignal<Parameters<AgentHost['apiProviders']['resolveCredential']>[0]>, Awaited<ReturnType<AgentHost['apiProviders']['resolveCredential']>>>;
  // Settles the journaled calls lost sessions left outstanding; see `RpcContinuity`.
  'calls.reconcile': Call<{ readonly calls: readonly OutstandingCall[] }, { readonly states: readonly OutstandingCallState[] }>;
}

export interface ExecutorRpcVersions {
  'apiProviders.discoverModels': { readonly 1: ExecutorRpcMethods['apiProviders.discoverModels'] };
  'auth.completeLogin': { readonly 1: ExecutorRpcMethods['auth.completeLogin'] };
  'auth.launchLogin': { readonly 1: ExecutorRpcMethods['auth.launchLogin'] };
  'auth.loginStatus': { readonly 1: ExecutorRpcMethods['auth.loginStatus'] };
  'auth.status': { readonly 1: ExecutorRpcMethods['auth.status'] };
  'calls.reconcile': { readonly 1: ExecutorRpcMethods['calls.reconcile'] };
  'catalog.snapshot': { readonly 1: ExecutorRpcMethods['catalog.snapshot'] };
  'commands.discover': { readonly 1: ExecutorRpcMethods['commands.discover'] };
  'compaction.compact': { readonly 1: ExecutorRpcMethods['compaction.compact'] };
  'configurationValidation.validate': { readonly 1: ExecutorRpcMethods['configurationValidation.validate'] };
  'controllerCli.describe': { readonly 1: ExecutorRpcMethods['controllerCli.describe'] };
  'controllerCli.request': { readonly 1: ExecutorRpcMethods['controllerCli.request'] };
  'credentials.resolve': { readonly 1: ExecutorRpcMethods['credentials.resolve'] };
  'endpoints.validate': { readonly 1: ExecutorRpcMethods['endpoints.validate'] };
  'execution.abort': { readonly 1: ExecutorRpcMethods['execution.abort'] };
  'execution.resume': { readonly 1: ExecutorRpcMethods['execution.resume'] };
  'execution.runningSessions': { readonly 1: ExecutorRpcMethods['execution.runningSessions'] };
  'execution.start': { readonly 1: ExecutorRpcMethods['execution.start'] };
  'executor.describe': { readonly 1: ExecutorRpcMethods['executor.describe'] };
  'files.browse': { readonly 1: ExecutorRpcMethods['files.browse'] };
  'files.createDirectory': { readonly 1: ExecutorRpcMethods['files.createDirectory'] };
  'files.identity': { readonly 1: ExecutorRpcMethods['files.identity'] };
  'files.list': { readonly 1: ExecutorRpcMethods['files.list'] };
  'files.read': { readonly 1: ExecutorRpcMethods['files.read'] };
  'files.revision': { readonly 1: ExecutorRpcMethods['files.revision'] };
  'files.save': { readonly 1: ExecutorRpcMethods['files.save'] };
  'files.tree': { readonly 1: ExecutorRpcMethods['files.tree'] };
  'forking.discard': { readonly 1: ExecutorRpcMethods['forking.discard'] };
  'forking.fork': { readonly 1: ExecutorRpcMethods['forking.fork'] };
  'gh.createPullRequestComment': { readonly 1: ExecutorRpcMethods['gh.createPullRequestComment'] };
  'gh.getPullRequest': { readonly 1: ExecutorRpcMethods['gh.getPullRequest'] };
  'gh.getPullRequestReviewTarget': { readonly 1: ExecutorRpcMethods['gh.getPullRequestReviewTarget'] };
  'gh.getStatus': { readonly 1: ExecutorRpcMethods['gh.getStatus'] };
  'gh.listPullRequests': { readonly 1: ExecutorRpcMethods['gh.listPullRequests'] };
  'gh.minimizePullRequestComment': { readonly 1: ExecutorRpcMethods['gh.minimizePullRequestComment'] };
  'git.acceptConflictSide': { readonly 1: ExecutorRpcMethods['git.acceptConflictSide'] };
  'git.applyStash': { readonly 1: ExecutorRpcMethods['git.applyStash'] };
  'git.checkout': { readonly 1: ExecutorRpcMethods['git.checkout'] };
  'git.collectCommitMessageContext': { readonly 1: ExecutorRpcMethods['git.collectCommitMessageContext'] };
  'git.commit': { readonly 1: ExecutorRpcMethods['git.commit'] };
  'git.commitIndex': { readonly 1: ExecutorRpcMethods['git.commitIndex'] };
  'git.createBranch': { readonly 1: ExecutorRpcMethods['git.createBranch'] };
  'git.createStash': { readonly 1: ExecutorRpcMethods['git.createStash'] };
  'git.createWorktree': { readonly 1: ExecutorRpcMethods['git.createWorktree'] };
  'git.deleteUntracked': { readonly 1: ExecutorRpcMethods['git.deleteUntracked'] };
  'git.discard': { readonly 1: ExecutorRpcMethods['git.discard'] };
  'git.dropStash': { readonly 1: ExecutorRpcMethods['git.dropStash'] };
  'git.fetch': { readonly 1: ExecutorRpcMethods['git.fetch'] };
  'git.getBlame': { readonly 1: ExecutorRpcMethods['git.getBlame'] };
  'git.getBranches': { readonly 1: ExecutorRpcMethods['git.getBranches'] };
  'git.getCommitSnapshot': { readonly 1: ExecutorRpcMethods['git.getCommitSnapshot'] };
  'git.getComparisonFreshness': { readonly 1: ExecutorRpcMethods['git.getComparisonFreshness'] };
  'git.getComparisonSnapshot': { readonly 1: ExecutorRpcMethods['git.getComparisonSnapshot'] };
  'git.getConflictDetails': { readonly 1: ExecutorRpcMethods['git.getConflictDetails'] };
  'git.getConflicts': { readonly 1: ExecutorRpcMethods['git.getConflicts'] };
  'git.getFileHistory': { readonly 1: ExecutorRpcMethods['git.getFileHistory'] };
  'git.getGraph': { readonly 1: ExecutorRpcMethods['git.getGraph'] };
  'git.getHistoryCommits': { readonly 1: ExecutorRpcMethods['git.getHistoryCommits'] };
  'git.getQuickSummary': { readonly 1: ExecutorRpcMethods['git.getQuickSummary'] };
  'git.getRefs': { readonly 1: ExecutorRpcMethods['git.getRefs'] };
  'git.getRemoteStatus': { readonly 1: ExecutorRpcMethods['git.getRemoteStatus'] };
  'git.getRemotes': { readonly 1: ExecutorRpcMethods['git.getRemotes'] };
  'git.getRepoInfo': { readonly 1: ExecutorRpcMethods['git.getRepoInfo'] };
  'git.getReviewDocumentFileBodies': { readonly 1: ExecutorRpcMethods['git.getReviewDocumentFileBodies'] };
  'git.getStashes': { readonly 1: ExecutorRpcMethods['git.getStashes'] };
  'git.getStatus': { readonly 1: ExecutorRpcMethods['git.getStatus'] };
  'git.getTargetCandidates': { readonly 1: ExecutorRpcMethods['git.getTargetCandidates'] };
  'git.getWorkbenchSnapshot': { readonly 1: ExecutorRpcMethods['git.getWorkbenchSnapshot'] };
  'git.getWorkingTreeFingerprint': { readonly 1: ExecutorRpcMethods['git.getWorkingTreeFingerprint'] };
  'git.getWorktrees': { readonly 1: ExecutorRpcMethods['git.getWorktrees'] };
  'git.initialCommit': { readonly 1: ExecutorRpcMethods['git.initialCommit'] };
  'git.markConflictResolved': { readonly 1: ExecutorRpcMethods['git.markConflictResolved'] };
  'git.popStash': { readonly 1: ExecutorRpcMethods['git.popStash'] };
  'git.pull': { readonly 1: ExecutorRpcMethods['git.pull'] };
  'git.push': { readonly 1: ExecutorRpcMethods['git.push'] };
  'git.removeWorktree': { readonly 1: ExecutorRpcMethods['git.removeWorktree'] };
  'git.revertCommit': { readonly 1: ExecutorRpcMethods['git.revertCommit'] };
  'git.stageHunk': { readonly 1: ExecutorRpcMethods['git.stageHunk'] };
  'git.stagePaths': { readonly 1: ExecutorRpcMethods['git.stagePaths'] };
  'git.stageSelection': { readonly 1: ExecutorRpcMethods['git.stageSelection'] };
  'history.close': { readonly 1: ExecutorRpcMethods['history.close'] };
  'history.next': { readonly 1: ExecutorRpcMethods['history.next'] };
  'history.open': { readonly 1: ExecutorRpcMethods['history.open'] };
  'lifecycle.migrateOwnedStorage': { readonly 1: ExecutorRpcMethods['lifecycle.migrateOwnedStorage'] };
  'lifecycle.start': { readonly 1: ExecutorRpcMethods['lifecycle.start'] };
  'lifecycle.stop': { readonly 1: ExecutorRpcMethods['lifecycle.stop'] };
  'migration.translateLegacyModel': { readonly 1: ExecutorRpcMethods['migration.translateLegacyModel'] };
  'migration.translateLegacyNativeSession': { readonly 1: ExecutorRpcMethods['migration.translateLegacyNativeSession'] };
  'migration.translateLegacySettings': { readonly 1: ExecutorRpcMethods['migration.translateLegacySettings'] };
  'nativeActivity.lastActivity': { readonly 1: ExecutorRpcMethods['nativeActivity.lastActivity'] };
  'nativeSessions.describeSource': { readonly 1: ExecutorRpcMethods['nativeSessions.describeSource'] };
  'nativeSessions.release': { readonly 1: ExecutorRpcMethods['nativeSessions.release'] };
  'nativeSessions.resolveNativeSession': { readonly 1: ExecutorRpcMethods['nativeSessions.resolveNativeSession'] };
  'permissions.respond': { readonly 1: ExecutorRpcMethods['permissions.respond'] };
  'producers.bind': { readonly 1: ExecutorRpcMethods['producers.bind'] };
  'producers.cancelLaunch': { readonly 1: ExecutorRpcMethods['producers.cancelLaunch'] };
  'producers.close': { readonly 1: ExecutorRpcMethods['producers.close'] };
  'producers.resume': { readonly 1: ExecutorRpcMethods['producers.resume'] };
  'projectPathUpdates.commit': { readonly 1: ExecutorRpcMethods['projectPathUpdates.commit'] };
  'projectPathUpdates.prepare': { readonly 1: ExecutorRpcMethods['projectPathUpdates.prepare'] };
  'projectPathUpdates.rollback': { readonly 1: ExecutorRpcMethods['projectPathUpdates.rollback'] };
  'projects.inspect': { readonly 1: ExecutorRpcMethods['projects.inspect'] };
  'projects.resolveFileMentions': { readonly 1: ExecutorRpcMethods['projects.resolveFileMentions'] };
  'projects.ticketProjectDefault': { readonly 1: ExecutorRpcMethods['projects.ticketProjectDefault'] };
  'readiness.status': { readonly 1: ExecutorRpcMethods['readiness.status'] };
  'sessionConfiguration.apply': { readonly 1: ExecutorRpcMethods['sessionConfiguration.apply'] };
  'settings.migrate': { readonly 1: ExecutorRpcMethods['settings.migrate'] };
  'singleQuery.run': { readonly 1: ExecutorRpcMethods['singleQuery.run'] };
  'steering.captureTarget': { readonly 1: ExecutorRpcMethods['steering.captureTarget'] };
  'steering.steer': { readonly 1: ExecutorRpcMethods['steering.steer'] };
  'terminals.attach': { readonly 1: ExecutorRpcMethods['terminals.attach'] };
  'terminals.create': { readonly 1: ExecutorRpcMethods['terminals.create'] };
  'terminals.detach': { readonly 1: ExecutorRpcMethods['terminals.detach'] };
  'terminals.input': { readonly 1: ExecutorRpcMethods['terminals.input'] };
  'terminals.list': { readonly 1: ExecutorRpcMethods['terminals.list'] };
  'terminals.rename': { readonly 1: ExecutorRpcMethods['terminals.rename'] };
  'terminals.resize': { readonly 1: ExecutorRpcMethods['terminals.resize'] };
  'terminals.terminate': { readonly 1: ExecutorRpcMethods['terminals.terminate'] };
}

export type RpcContractRef<K extends keyof ExecutorRpcVersions = keyof ExecutorRpcVersions> = {
  [M in K]: {
    [V in keyof ExecutorRpcVersions[M] & number]: RpcContractDefinition & { readonly name: M; readonly version: V }
  }[keyof ExecutorRpcVersions[M] & number]
}[K];

type RpcPayload<D extends ContractRef, Field extends 'request' | 'result'> = D extends ContractRef
  ? D['name'] extends keyof ExecutorRpcVersions
    ? D['version'] extends keyof ExecutorRpcVersions[D['name']]
      ? ExecutorRpcVersions[D['name']][D['version']] extends Record<Field, infer T> ? T : never
      : never
    : unknown
  : never;

export type RpcRequest<D extends ContractRef> = RpcPayload<D, 'request'>;
export type RpcResult<D extends ContractRef> = RpcPayload<D, 'result'>;
export type RequestFor<D extends RpcContractDefinition> = Extract<ExecutorRpcRequest,
  D extends RpcContractDefinition ? { method: D['name']; version: D['version'] } : never>;

export type ExecutorRpcRequest = {
  [K in keyof ExecutorRpcVersions]: {
    [V in keyof ExecutorRpcVersions[K]]: {
      readonly type: 'request'; readonly id: string; readonly integrationId: string;
      readonly seq: number; readonly method: K; readonly version: V;
      readonly request: ExecutorRpcVersions[K][V] extends { readonly request: infer Q } ? Q : never;
    }
  }[keyof ExecutorRpcVersions[K]]
}[keyof ExecutorRpcVersions];

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

// Calls that install a replacement session. They bypass the request budgets,
// so the calls a session recovers cannot keep it from installing.
export const SESSION_INSTALLATION_METHODS: ReadonlySet<string> = new Set<keyof ExecutorRpcMethods>([
  'executor.describe', 'lifecycle.migrateOwnedStorage', 'lifecycle.start', 'producers.resume', 'calls.reconcile',
]);

export function rpcContinuity(contract: RpcContractDefinition): RpcContinuity { return contract.continuity; }

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
