import type { AgentDescriptor, AgentSettingDescriptor, AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import type {
  AgentIntegration,
  AgentHost,
  AgentHistoryImportRequest,
  AgentImportedTranscriptRow,
  AgentProducerNotification,
  AgentResourceRef,
  AgentResourceScope,
  ExecutionNodeInfo,
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

export interface AgentRpcMethods {
  'node.describe': Call<null, { readonly info: ExecutionNodeInfo; readonly integrations: readonly IntegrationManifest[] }>;
  'projects.inspect': Call<Parameters<ExecutionProjectService['inspect']>[0], Awaited<ReturnType<ExecutionProjectService['inspect']>>>;
  'projects.resolveFileMentions': Call<Parameters<ExecutionProjectService['resolveFileMentions']>[0], string>;
  'producers.bind': Call<Request<'producers', 'bind'>, void>;
  'producers.close': Call<Request<'producers', 'close'>, void>;
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
  'history.next': Call<HistoryReaderRef, { readonly done: boolean; readonly rows: readonly AgentImportedTranscriptRow[] }>;
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
}

export type AgentRpcRequest = {
  [K in keyof AgentRpcMethods]: {
    readonly type: 'request'; readonly id: string; readonly integrationId: string;
    readonly method: K; readonly request: AgentRpcMethods[K]['request'];
  }
}[keyof AgentRpcMethods];

export interface AgentProducerFrame {
  readonly type: 'producer';
  readonly notification: AgentProducerNotification;
}
