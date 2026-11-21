import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentIntegration, ExecutionRuntimeApi } from '@garcon/server-agent-interface';
import type { AutomationStartInput } from '../../../../common/automation.js';
import { effectiveExecutorId, LOCAL_EXECUTOR_ID } from '../../../../common/executors.js';
import type { ProjectInspector } from '../../../../common/project-resolution.js';
import { DomainError } from '../../../common/domain-error.js';
import { KeyedPromiseLock } from '../../../common/keyed-lock.js';
import { IntegrationRegistry } from '../../../runtime/agents/integration-registry.js';
import { defaultAgentIntegrations } from '../../../runtime/agents/default-agent-integrations.js';
import { ExecutionRuntime } from '../../../runtime/execution-runtime.js';
import { runtimeAdapter, type RuntimeBackend } from '../../../remote/__tests__/runtime-adapter.js';
import { AgentDirectory, type ExecutionIntegrationDirectory } from '../../agents/directory.js';
import { AgentRegistry } from '../../agents/registry.js';
import type { TurnEventMetadata } from '../../agents/event-bus.js';
import { ApiProviderEndpointResolver } from '../../api-providers/endpoint-resolver.js';
import { ChatExecutionCoordinator } from '../../chat-execution/chat-execution-coordinator.js';
import { InMemoryChatExecutionControlRepository } from '../../chat-execution/chat-execution-control-repository.js';
import { ChatIdAllocator } from '../../chats/chat-id-allocator.js';
import { queuedAttachmentAdmission, queueDrainOptions } from '../../chats/chat-execution-options.js';
import { RecentTitleIconStore } from '../../chats/recent-title-icons.js';
import { ChatRegistry } from '../../chats/store.js';
import { ChatCommandService } from '../../commands/chat-command-service.js';
import { commandLedgerKey, CommandLedger } from '../../commands/command-ledger.js';
import { TranscriptAdoptionService } from '../../ledger/adoption.js';
import { TranscriptLedgerService } from '../../ledger/service.js';
import { TranscriptLedgerStore } from '../../ledger/store.js';
import { ProjectAdmission } from '../../projects/project-admission.js';

const REMOTE_ID = '22222222-2222-4222-8222-222222222222';
const noop = () => {};
const unused = (): never => { throw new Error('Not used by the managed turn fixture'); };

export function executorIdFor(backend: RuntimeBackend) {
  return backend === 'local' ? LOCAL_EXECUTOR_ID : REMOTE_ID;
}

export async function managedWorkspace() {
  const temp = join(homedir(), 'tmp');
  await mkdir(temp, { recursive: true });
  const root = await mkdtemp(join(temp, 'managed-turn-test-'));
  const project = join(root, 'project');
  await mkdir(project);
  return { root, project, dispose: () => rm(root, { recursive: true, force: true }) };
}

export function managedRuntime(
  workspace: Awaited<ReturnType<typeof managedWorkspace>>,
  backend: RuntimeBackend,
  agentId: string,
  environment: Readonly<Record<string, string>> = {},
) {
  return new ExecutionRuntime({
    id: executorIdFor(backend), workspaceDir: join(workspace.root, 'executor'), projectBasePath: workspace.project,
    integrations: defaultAgentIntegrations.filter(integration => integration.integrationId === agentId),
    resolveCredential: async () => null,
    readEnvironment: key => environment[key] ?? (key === 'PATH' ? process.env.PATH : undefined),
    loggerFactory: () => ({ debug: noop, info: noop, warn: noop, error: noop }),
  });
}

export async function managedController(
  workspace: Awaited<ReturnType<typeof managedWorkspace>>,
  runtime: ExecutionRuntimeApi,
  backend: RuntimeBackend,
  agentId: string,
) {
  const adapter = await runtimeAdapter(runtime, backend);
  try {
    const { executor } = adapter;
    const integration = await executor.getAgentIntegration(agentId);
    const serverInstanceId = crypto.randomUUID();
    const chats = new ChatRegistry(workspace.root);
    await chats.init();
    const store = new TranscriptLedgerStore(join(workspace.root, 'ledger'));
    const transcripts = new TranscriptLedgerService(store, { serverInstanceId });
    const ledger = new CommandLedger();
    const integrations = new IntegrationRegistry({ instances: [integration] });
    const executors = {
      isReady: id => id === executor.id && executor.availability === 'ready',
      integrationsFor: id => {
        if (id !== executor.id) throw new DomainError('EXECUTOR_UNAVAILABLE', 'Executor unavailable', 503);
        return integrations;
      },
      knownIntegration: ({ executorId, agentId: id }) => executorId === executor.id ? integrations.get(id) : null,
      requireIntegration({ executorId, agentId: id }) { return this.integrationsFor(executorId).require(id); },
    } satisfies ExecutionIntegrationDirectory;
    const inspectProject: ProjectInspector = async (projectPath, id, options) => {
      if (effectiveExecutorId(id) !== executor.id) throw new Error('Project call was retargeted');
      return (await (await executor.getProjectService(options)).inspect({ projectPath }, options)).resolution;
    };
    const directory = new AgentDirectory(executors);
    const adoption = new TranscriptAdoptionService({
      ledger: transcripts, registry: chats, integrations: directory,
      getCarryOverRevision: () => '', loadFrozenPrefix: async () => [],
    });
    const chatMutationLock = new KeyedPromiseLock();
    const selectionAdmissionLock = new KeyedPromiseLock();
    const preambles = { snapshot: () => ({ revision: 0, preambles: [] }) };
    const agents = new AgentRegistry({
      registry: chats, executors,
      endpointResolver: new ApiProviderEndpointResolver(() => []),
      getCarryOverRevision: () => '', createCarriedContext: async () => ({ kind: 'no-history' }),
      chatMutationLock, selectionAdmissionLock, ledger: transcripts, adoption,
      preambles, hasPendingOwnershipTransfer: () => false, resolveFileMentions: async content => content,
      getSettingsExecution: (): ChatExecutionCoordinator => queue,
    });
    const queue = new ChatExecutionCoordinator(
      agents, agents, chatId => queueDrainOptions(chatId, chats), chatId => chats.hasChat(chatId),
      new InMemoryChatExecutionControlRepository(serverInstanceId), {
        projectAdmission: new ProjectAdmission(chats, inspectProject),
        attachmentAdmission: queuedAttachmentAdmission(chats, agents),
        executionPolicy: id => agents.chatExecutionPolicy(id), selectionAdmissionLock,
        canDispatch: id => executors.isReady(effectiveExecutorId(chats.getChat(id)?.executorId)),
        isControlInputViewCurrent: (id, viewId) => chats.hasChat(id) && transcripts.existingCurrentView(id)?.viewId === viewId,
      },
    );
    const commands = new ChatCommandService({
      chats, queue, ledger, metadata: { addNewChatMetadata: noop, getChatMetadata: () => null },
      settings: {
        getUiSettings: () => null, getChatName: () => null, setSessionName: async () => {},
        setSessionNameIfAbsent: async () => false, setDerivedSessionName: unused, ensureInNormal: async () => {},
        removeFromAllOrderLists: async () => {}, removeSessionName: async () => {}, recordChatStartup: async () => {},
      },
      recentTitleIcons: new RecentTitleIconStore(), agents,
      chatListProjector: { buildOne: unused }, inspectProject, transcripts, preambles, chatMutationLock,
      fileMentions: { resolve: async content => content }, ownership: { delete: unused },
      createForkedChat: unused, readForkedNativeHistory: unused,
      handoffs: { resolveTarget: unused, createPreparation: unused, cancelPreparation: unused, seedContinuationLedger: unused, deleteContinuationLedger: unused },
      transientFeeds: { validateAction: unused }, chatTags: { applyDeltaWhileChatLocked: unused },
    });
    transcripts.subscribeRunEndedCommitted((chatId, runId) => queue.markRunTerminalCommitted(chatId, runId));
    agents.onTranscriptCommitted(async event => {
      if (event.type === 'run-ended') await ledger.setTurnResult(event.chatId, event.runId, event.finalResponse);
    });
    async function settle(chatId: string, turn: TurnEventMetadata | undefined, outcome: 'finished' | 'interrupted' | 'failed', error?: string, errorCode?: string) {
      if (!turn?.turnId || !turn.clientRequestId || !turn.commandType) return;
      await queue.onAgentTurnTerminal(chatId, turn, outcome === 'failed' ? 'failed' : 'finished');
      await ledger.settleTerminal(commandLedgerKey(turn.commandType, chatId, turn.clientRequestId),
        outcome === 'failed' ? 'failed' : 'finished', { error, errorCode });
      await ledger.markPublicTerminal(chatId, turn.turnId, outcome === 'interrupted' ? 'user-stop' : undefined);
    }
    agents.onFinished((chatId, _exit, turn, outcome) => settle(chatId, turn, outcome));
    agents.onFailed((chatId, message, code, turn) => settle(chatId, turn, 'failed', message, code));
    queue.onTurnSettled((chatId, turn) => { if (turn) agents.settleTurn(chatId, turn); });
    queue.onSessionStopped((chatId, outcome, _intent, turn) => {
      if (outcome === 'interrupt-requested' && turn?.turnId) {
        queueMicrotask(() => { void ledger.markInterruptedWithoutRunTerminal(chatId, turn.turnId!, 'user-stop'); });
      }
    });
    const automation = commands.createAutomation({ serverInstanceId, chatIds: new ChatIdAllocator(chats), execution: queue });
    let disposed = false;
    return {
      automation, agents, queue, ledger, transcripts, chats, integration,
      async dispose() {
        if (disposed) return;
        disposed = true;
        automation.beginShutdown();
        transcripts.close();
        await chats.flush();
        await adapter.dispose();
      },
    };
  } catch (error) {
    await adapter.dispose();
    throw error;
  }
}

export function managedInput(integration: AgentIntegration, projectPath: string, model: string, command: string): AutomationStartInput {
  return {
    executorId: integration.producers.scope.executorId, clientRequestId: crypto.randomUUID(), projectPath,
    agentId: integration.descriptor.id, model, command,
    permissionMode: 'default', thinkingMode: integration.descriptor.supportedThinkingModes[0] ?? 'none',
    agentSettings: integration.settings.defaults(), orderedPreambleIds: [], title: 'Synthetic managed turn',
  };
}
