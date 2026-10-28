import { defineContract, supportsDefinition, type ContractDefinition, type ContractRef, type ContractVersions } from './protocol-contracts.js';

export type ExecutorContractDirection = 'controller-to-worker' | 'worker-to-controller' | 'both';
export type ExecutorContractLane = 'primary' | 'bulk' | 'calling' | 'cli';
export type ExecutorContractContinuity = 'session' | 'launch' | 'journaled';

export interface RpcContractDefinition extends ContractDefinition {
  readonly direction: ExecutorContractDirection;
  readonly lane: ExecutorContractLane;
  readonly continuity: ExecutorContractContinuity;
  readonly acceptsResource?: ContractRef;
  readonly returnsResource?: ContractRef;
}

function rpc<const N extends string>(name: N, lane: ExecutorContractLane, continuity: ExecutorContractContinuity,
  direction: ExecutorContractDirection, requires: readonly ContractRef[], resources: Pick<RpcContractDefinition, 'acceptsResource' | 'returnsResource'> = {}) {
  return Object.freeze({ ...defineContract(name, 1, requires), lane, continuity, direction, ...resources });
}

export const PRODUCER_EVENTS_V1 = Object.freeze({
  rows: defineContract('producer.rows', 1, []),
  session: defineContract('producer.session', 1, []),
  permission: defineContract('producer.permission', 1, []),
  notice: defineContract('producer.notice', 1, []),
  'run-ended': defineContract('producer.run-ended', 1, []),
  started: defineContract('producer.started', 1, []),
  steerable: defineContract('producer.steerable', 1, []),
  'publication-failed': defineContract('producer.publication-failed', 1, []),
  'publication-gap': defineContract('producer.publication-gap', 1, []),
  'launch-settled': defineContract('producer.launch-settled', 1, []),
});

export const TERMINAL_EVENTS_V1 = Object.freeze({
  'terminal-attached': defineContract('terminal.attached', 1, []),
  'terminal-output': defineContract('terminal.output', 1, []),
  'terminal-replay-batch': defineContract('terminal.replay-batch', 1, []),
  'terminal-output-fragment': defineContract('terminal.output-fragment', 1, []),
  'terminal-status': defineContract('terminal.status', 1, []),
  'terminal-taken-over': defineContract('terminal.taken-over', 1, []),
  'terminal-terminated': defineContract('terminal.terminated', 1, []),
  'terminal-replay-truncated': defineContract('terminal.replay-truncated', 1, []),
  'terminal-error': defineContract('terminal.error', 1, []),
});

export const PRODUCER_BINDING_V1 = Object.freeze({ ...defineContract('resource.producer-binding', 1, []),
  events: Object.freeze(Object.keys(PRODUCER_EVENTS_V1)) });
export const TERMINAL_ATTACHMENT_V1 = Object.freeze({ ...defineContract('resource.terminal-attachment', 1, []),
  events: Object.freeze(Object.keys(TERMINAL_EVENTS_V1)) });
export const HISTORY_READER_V1 = defineContract('resource.history-reader', 1, []);

const journal = [defineContract('calls.reconcile', 1, [])] as const;
const producer = [PRODUCER_BINDING_V1] as const;
const binding = [...producer, ...journal, { name: 'producers.close', version: 1 },
  { name: 'producers.resume', version: 1 }, ...Object.values(PRODUCER_EVENTS_V1)] as const;
const launch = [...producer, ...journal, { name: 'execution.abort', version: 1 },
  { name: 'permissions.respond', version: 1 }, { name: 'producers.close', version: 1 },
  { name: 'producers.cancelLaunch', version: 1 }] as const;
const attachment = [TERMINAL_ATTACHMENT_V1] as const;
const attach = [...attachment, ...Object.values(TERMINAL_EVENTS_V1), { name: 'terminals.detach', version: 1 }] as const;
const reader = [HISTORY_READER_V1] as const;
const openReader = [...reader, { name: 'history.next', version: 1 }, { name: 'history.close', version: 1 }] as const;

export const RPC_V1 = Object.freeze({
  'apiProviders.discoverModels': rpc('apiProviders.discoverModels', 'primary', 'journaled', 'controller-to-worker', journal),
  'auth.completeLogin': rpc('auth.completeLogin', 'primary', 'journaled', 'controller-to-worker', journal),
  'auth.launchLogin': rpc('auth.launchLogin', 'primary', 'journaled', 'controller-to-worker', journal),
  'auth.loginStatus': rpc('auth.loginStatus', 'primary', 'journaled', 'controller-to-worker', journal),
  'auth.status': rpc('auth.status', 'primary', 'journaled', 'controller-to-worker', journal),
  'calls.reconcile': rpc('calls.reconcile', 'calling', 'session', 'both', []),
  'catalog.snapshot': rpc('catalog.snapshot', 'primary', 'journaled', 'controller-to-worker', journal),
  'commands.discover': rpc('commands.discover', 'primary', 'journaled', 'controller-to-worker', journal),
  'compaction.compact': rpc('compaction.compact', 'primary', 'launch', 'controller-to-worker', launch, { acceptsResource: PRODUCER_BINDING_V1 }),
  'configurationValidation.validate': rpc('configurationValidation.validate', 'primary', 'journaled', 'controller-to-worker', journal),
  'controllerCli.describe': rpc('controllerCli.describe', 'primary', 'session', 'worker-to-controller', []),
  'controllerCli.request': rpc('controllerCli.request', 'cli', 'session', 'worker-to-controller', []),
  'credentials.resolve': rpc('credentials.resolve', 'primary', 'session', 'worker-to-controller', []),
  'endpoints.validate': rpc('endpoints.validate', 'primary', 'journaled', 'controller-to-worker', journal),
  'execution.abort': rpc('execution.abort', 'primary', 'journaled', 'controller-to-worker', journal),
  'execution.resume': rpc('execution.resume', 'primary', 'launch', 'controller-to-worker', launch, { acceptsResource: PRODUCER_BINDING_V1 }),
  'execution.runningSessions': rpc('execution.runningSessions', 'primary', 'journaled', 'controller-to-worker', journal),
  'execution.start': rpc('execution.start', 'primary', 'launch', 'controller-to-worker', launch, { acceptsResource: PRODUCER_BINDING_V1 }),
  'executor.describe': rpc('executor.describe', 'primary', 'session', 'controller-to-worker', []),
  'files.browse': rpc('files.browse', 'bulk', 'journaled', 'controller-to-worker', journal),
  'files.createDirectory': rpc('files.createDirectory', 'bulk', 'journaled', 'controller-to-worker', journal),
  'files.identity': rpc('files.identity', 'primary', 'journaled', 'controller-to-worker', journal),
  'files.list': rpc('files.list', 'bulk', 'journaled', 'controller-to-worker', journal),
  'files.read': rpc('files.read', 'bulk', 'journaled', 'controller-to-worker', journal),
  'files.revision': rpc('files.revision', 'primary', 'journaled', 'controller-to-worker', journal),
  'files.save': rpc('files.save', 'bulk', 'journaled', 'controller-to-worker', journal),
  'files.tree': rpc('files.tree', 'bulk', 'journaled', 'controller-to-worker', journal),
  'forking.discard': rpc('forking.discard', 'primary', 'journaled', 'controller-to-worker', journal),
  'forking.fork': rpc('forking.fork', 'primary', 'session', 'controller-to-worker', [...journal, { name: 'forking.discard', version: 1 }]),
  'gh.createPullRequestComment': rpc('gh.createPullRequestComment', 'bulk', 'journaled', 'controller-to-worker', journal),
  'gh.getPullRequest': rpc('gh.getPullRequest', 'bulk', 'journaled', 'controller-to-worker', journal),
  'gh.getPullRequestReviewTarget': rpc('gh.getPullRequestReviewTarget', 'bulk', 'journaled', 'controller-to-worker', journal),
  'gh.getStatus': rpc('gh.getStatus', 'bulk', 'journaled', 'controller-to-worker', journal),
  'gh.listPullRequests': rpc('gh.listPullRequests', 'bulk', 'journaled', 'controller-to-worker', journal),
  'gh.minimizePullRequestComment': rpc('gh.minimizePullRequestComment', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.acceptConflictSide': rpc('git.acceptConflictSide', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.applyStash': rpc('git.applyStash', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.checkout': rpc('git.checkout', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.collectCommitMessageContext': rpc('git.collectCommitMessageContext', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.commit': rpc('git.commit', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.commitIndex': rpc('git.commitIndex', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.createBranch': rpc('git.createBranch', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.createStash': rpc('git.createStash', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.createWorktree': rpc('git.createWorktree', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.deleteUntracked': rpc('git.deleteUntracked', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.discard': rpc('git.discard', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.dropStash': rpc('git.dropStash', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.fetch': rpc('git.fetch', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.getBlame': rpc('git.getBlame', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.getBranches': rpc('git.getBranches', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.getCommitSnapshot': rpc('git.getCommitSnapshot', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.getComparisonFreshness': rpc('git.getComparisonFreshness', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.getComparisonSnapshot': rpc('git.getComparisonSnapshot', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.getConflictDetails': rpc('git.getConflictDetails', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.getConflicts': rpc('git.getConflicts', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.getFileHistory': rpc('git.getFileHistory', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.getGraph': rpc('git.getGraph', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.getHistoryCommits': rpc('git.getHistoryCommits', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.getQuickSummary': rpc('git.getQuickSummary', 'primary', 'journaled', 'controller-to-worker', journal),
  'git.getRefs': rpc('git.getRefs', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.getRemoteStatus': rpc('git.getRemoteStatus', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.getRemotes': rpc('git.getRemotes', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.getRepoInfo': rpc('git.getRepoInfo', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.getReviewDocumentFileBodies': rpc('git.getReviewDocumentFileBodies', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.getStashes': rpc('git.getStashes', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.getStatus': rpc('git.getStatus', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.getTargetCandidates': rpc('git.getTargetCandidates', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.getWorkbenchSnapshot': rpc('git.getWorkbenchSnapshot', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.getWorkingTreeFingerprint': rpc('git.getWorkingTreeFingerprint', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.getWorktrees': rpc('git.getWorktrees', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.initialCommit': rpc('git.initialCommit', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.markConflictResolved': rpc('git.markConflictResolved', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.popStash': rpc('git.popStash', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.pull': rpc('git.pull', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.push': rpc('git.push', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.removeWorktree': rpc('git.removeWorktree', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.revertCommit': rpc('git.revertCommit', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.stageHunk': rpc('git.stageHunk', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.stagePaths': rpc('git.stagePaths', 'bulk', 'journaled', 'controller-to-worker', journal),
  'git.stageSelection': rpc('git.stageSelection', 'bulk', 'journaled', 'controller-to-worker', journal),
  'history.close': rpc('history.close', 'bulk', 'session', 'controller-to-worker', reader, { acceptsResource: HISTORY_READER_V1 }),
  'history.next': rpc('history.next', 'bulk', 'session', 'controller-to-worker', reader, { acceptsResource: HISTORY_READER_V1 }),
  'history.open': rpc('history.open', 'bulk', 'session', 'controller-to-worker', openReader, { returnsResource: HISTORY_READER_V1 }),
  'lifecycle.migrateOwnedStorage': rpc('lifecycle.migrateOwnedStorage', 'primary', 'session', 'controller-to-worker', []),
  'lifecycle.start': rpc('lifecycle.start', 'primary', 'session', 'controller-to-worker', [{ name: 'lifecycle.stop', version: 1 }]),
  'lifecycle.stop': rpc('lifecycle.stop', 'primary', 'session', 'controller-to-worker', []),
  'migration.translateLegacyModel': rpc('migration.translateLegacyModel', 'primary', 'journaled', 'controller-to-worker', journal),
  'migration.translateLegacyNativeSession': rpc('migration.translateLegacyNativeSession', 'primary', 'journaled', 'controller-to-worker', journal),
  'migration.translateLegacySettings': rpc('migration.translateLegacySettings', 'primary', 'journaled', 'controller-to-worker', journal),
  'nativeActivity.lastActivity': rpc('nativeActivity.lastActivity', 'primary', 'journaled', 'controller-to-worker', journal),
  'nativeSessions.describeSource': rpc('nativeSessions.describeSource', 'primary', 'journaled', 'controller-to-worker', journal),
  'nativeSessions.release': rpc('nativeSessions.release', 'primary', 'journaled', 'controller-to-worker', journal),
  'nativeSessions.resolveNativeSession': rpc('nativeSessions.resolveNativeSession', 'primary', 'journaled', 'controller-to-worker', journal),
  'permissions.respond': rpc('permissions.respond', 'primary', 'journaled', 'controller-to-worker', [...producer, ...journal]),
  'producers.bind': rpc('producers.bind', 'primary', 'session', 'controller-to-worker', binding, { returnsResource: PRODUCER_BINDING_V1 }),
  'producers.cancelLaunch': rpc('producers.cancelLaunch', 'primary', 'journaled', 'controller-to-worker', [...producer, ...journal], { acceptsResource: PRODUCER_BINDING_V1 }),
  'producers.close': rpc('producers.close', 'primary', 'journaled', 'controller-to-worker', [...producer, ...journal], { acceptsResource: PRODUCER_BINDING_V1 }),
  'producers.resume': rpc('producers.resume', 'primary', 'session', 'controller-to-worker', producer, { acceptsResource: PRODUCER_BINDING_V1 }),
  'projectPathUpdates.commit': rpc('projectPathUpdates.commit', 'primary', 'journaled', 'controller-to-worker', journal),
  'projectPathUpdates.prepare': rpc('projectPathUpdates.prepare', 'primary', 'session', 'controller-to-worker', [...journal,
    { name: 'projectPathUpdates.commit', version: 1 }, { name: 'projectPathUpdates.rollback', version: 1 }]),
  'projectPathUpdates.rollback': rpc('projectPathUpdates.rollback', 'primary', 'journaled', 'controller-to-worker', journal),
  'projects.inspect': rpc('projects.inspect', 'primary', 'journaled', 'controller-to-worker', journal),
  'projects.resolveFileMentions': rpc('projects.resolveFileMentions', 'primary', 'journaled', 'controller-to-worker', journal),
  'projects.ticketProjectDefault': rpc('projects.ticketProjectDefault', 'primary', 'journaled', 'controller-to-worker', journal),
  'readiness.status': rpc('readiness.status', 'primary', 'journaled', 'controller-to-worker', journal),
  'sessionConfiguration.apply': rpc('sessionConfiguration.apply', 'primary', 'journaled', 'controller-to-worker', journal),
  'settings.migrate': rpc('settings.migrate', 'primary', 'journaled', 'controller-to-worker', journal),
  'singleQuery.run': rpc('singleQuery.run', 'primary', 'journaled', 'controller-to-worker', journal),
  'steering.captureTarget': rpc('steering.captureTarget', 'primary', 'journaled', 'controller-to-worker', journal),
  'steering.steer': rpc('steering.steer', 'primary', 'journaled', 'controller-to-worker', journal),
  'terminals.attach': rpc('terminals.attach', 'primary', 'session', 'controller-to-worker', attach, { returnsResource: TERMINAL_ATTACHMENT_V1 }),
  'terminals.create': rpc('terminals.create', 'primary', 'session', 'controller-to-worker', []),
  'terminals.detach': rpc('terminals.detach', 'primary', 'session', 'controller-to-worker', attachment, { acceptsResource: TERMINAL_ATTACHMENT_V1 }),
  'terminals.input': rpc('terminals.input', 'primary', 'session', 'controller-to-worker', attachment, { acceptsResource: TERMINAL_ATTACHMENT_V1 }),
  'terminals.list': rpc('terminals.list', 'primary', 'session', 'controller-to-worker', []),
  'terminals.rename': rpc('terminals.rename', 'primary', 'session', 'controller-to-worker', []),
  'terminals.resize': rpc('terminals.resize', 'primary', 'session', 'controller-to-worker', attachment, { acceptsResource: TERMINAL_ATTACHMENT_V1 }),
  'terminals.terminate': rpc('terminals.terminate', 'primary', 'session', 'controller-to-worker', []),
});

export type ExecutorOperation = keyof typeof RPC_V1;

export const EXECUTION_INITIALIZATION_V1 = Object.freeze([
  RPC_V1['lifecycle.migrateOwnedStorage'], RPC_V1['lifecycle.start'], RPC_V1['lifecycle.stop'],
]);
export const EXECUTION_WORKFLOW_V1 = Object.freeze([
  ...EXECUTION_INITIALIZATION_V1, RPC_V1['producers.bind'], RPC_V1['catalog.snapshot'],
  RPC_V1['execution.runningSessions'], RPC_V1['projects.inspect'], RPC_V1['projects.resolveFileMentions'],
]);

export function supportsWorkflow(contracts: ContractVersions, definitions: readonly ContractDefinition[]): boolean {
  return definitions.every(definition => supportsDefinition(contracts, definition));
}

export function supportsProviderInitialization(supports: (requirements: readonly RpcContractDefinition[]) => boolean): boolean {
  return supports(EXECUTION_WORKFLOW_V1)
    && [RPC_V1['execution.start'], RPC_V1['execution.resume'], RPC_V1['compaction.compact']]
      .some(definition => supports([definition]));
}

export function supportedExecutorOperations(contracts: ContractVersions): readonly ExecutorOperation[] {
  return Object.freeze(Object.values(RPC_V1).filter(definition => supportsDefinition(contracts, definition)).map(definition => definition.name));
}

// Local calls use their in-process implementations; this is only the paired UI's support projection.
export const LOCAL_EXECUTOR_OPERATIONS = Object.freeze(Object.keys(RPC_V1) as ExecutorOperation[]);

export const PRODUCER_CREATOR_V1 = Object.freeze({ contract: RPC_V1['producers.bind'], resource: PRODUCER_BINDING_V1, codecs: PRODUCER_EVENTS_V1 });
export const TERMINAL_CREATOR_V1 = Object.freeze({ contract: RPC_V1['terminals.attach'], resource: TERMINAL_ATTACHMENT_V1, codecs: TERMINAL_EVENTS_V1,
  detach: RPC_V1['terminals.detach'] });

export interface EventCreator {
  readonly contract: RpcContractDefinition;
  readonly resource: ContractDefinition & { readonly events: readonly string[] };
  readonly codecs: Readonly<Record<string, ContractDefinition>>;
}

export function assertCreator(creator: EventCreator): void {
  const requirements = new Set(creator.contract.requires.map(ref => `${ref.name}@${ref.version}`));
  if (!requirements.has(`${creator.resource.name}@${creator.resource.version}`)
    || creator.resource.events.some(kind => !Object.hasOwn(creator.codecs, kind))
    || Object.values(creator.codecs).some(codec => !requirements.has(`${codec.name}@${codec.version}`))) {
    throw new Error(`Incomplete creator codecs: ${creator.contract.name}@${creator.contract.version}`);
  }
}
