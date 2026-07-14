import { getAuthToken } from '$lib/api/client.js';
import * as m from '$lib/paraglide/messages.js';
import type { AppShellStore } from '$lib/stores/app-shell.svelte.js';
import type { AuthStore } from '$lib/stores/auth.svelte.js';
import type { ChatSessionsStore } from '$lib/stores/chat-sessions.svelte.js';
import { FileSessionRegistry } from '$lib/stores/file-sessions.svelte.js';
import type { GhCapabilityStore } from '$lib/stores/gh-capability.svelte.js';
import { GitQuickSummaryStore } from '$lib/stores/git-quick-summary.svelte.js';
import { gitProjectInvalidations } from '$lib/stores/git-project-invalidation.svelte.js';
import { GitMutationCoordinator } from '$lib/stores/git-mutations.svelte.js';
import { GitBranchSelectorState } from '$lib/stores/git/git-branch-selector-state.svelte.js';
import type { LocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
import type { ModelCatalogStore } from '$lib/stores/model-catalog.svelte.js';
import type { NavigationStore } from '$lib/stores/navigation.svelte.js';
import type { NotificationsStore } from '$lib/stores/notifications.svelte.js';
import { createPullRequestsStore } from '$lib/stores/pull-requests.svelte.js';
import { CommitController } from '$lib/stores/commit.svelte.js';
import { SingletonSurfaceRegistry } from '$lib/stores/singleton-surfaces.svelte.js';
import { TerminalRegistry } from '$lib/stores/terminal-registry.svelte.js';
import { createWorkspaceLayoutStore } from '$lib/stores/workspace-layout.svelte.js';
import { getLocalStorageItem, LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence.js';
import { ChatInteractionGate } from './chat-interaction-gate.svelte.js';
import { parsePersistedWorkspaceLayout } from './layout-schema.js';
import { SurfaceFrameRegistry } from './surface-frame-registry.svelte.js';
import { TransientLayerRegistry } from './transient-layers.svelte.js';
import { createWorkspaceContextStore } from './workspace-context.svelte.js';
import { WorkspaceCoordinator } from './workspace-coordinator.svelte.js';
import { WorkspaceDomainBindings } from './workspace-domain-bindings.svelte.js';
import { WorkspaceLayoutPersistence } from './workspace-layout-persistence.js';
import { WorkspaceShortcutDispatcher } from './workspace-shortcuts.js';
import { WorkspaceTransitionArbiter } from './workspace-transition-arbiter.js';
import type { WorkspaceLayoutReader } from './surface-types.js';

export interface WorkspaceRootDependencies {
	auth: AuthStore;
	appShell: AppShellStore;
	chatSessions: ChatSessionsStore;
	ghCapability: GhCapabilityStore;
	localSettings: LocalSettingsStore;
	modelCatalog: ModelCatalogStore;
	navigation: NavigationStore;
	notifications: NotificationsStore;
	terminalIdentity: { readonly clientId: string | null };
	getRouteIdentity(): string;
	onTerminalLauncherDismissed(): void;
	workspaceLayoutRaw?: string | null;
}

export interface WorkspaceServices {
	restore: ReturnType<typeof parsePersistedWorkspaceLayout>;
	layout: WorkspaceLayoutReader;
	context: ReturnType<typeof createWorkspaceContextStore>;
	terminals: TerminalRegistry;
	chatInteractionGate: ChatInteractionGate;
	transientLayers: TransientLayerRegistry;
	surfaceFrames: SurfaceFrameRegistry;
	gitQuickSummary: GitQuickSummaryStore;
	gitMutations: GitMutationCoordinator;
	gitBranchActions: GitBranchSelectorState;
	singletonSurfaces: SingletonSurfaceRegistry;
	files: FileSessionRegistry;
	coordinator: WorkspaceCoordinator;
	shortcuts: WorkspaceShortcutDispatcher;
	destroy(): void;
}

export function createWorkspaceServices(deps: WorkspaceRootDependencies): WorkspaceServices {
	const workspaceLayoutRaw =
		deps.workspaceLayoutRaw === undefined
			? getLocalStorageItem(LOCAL_STORAGE_KEYS.workspaceLayout)
			: deps.workspaceLayoutRaw;
	const restore = parsePersistedWorkspaceLayout(workspaceLayoutRaw);
	const layout = createWorkspaceLayoutStore(restore.snapshot);
	const persistence = new WorkspaceLayoutPersistence({
		onError: (_error, retry) => {
			deps.notifications.error(m.workspace_layout_persistence_failed(), {
				key: 'workspace-layout-persistence',
				timeoutMs: null,
				action: { label: m.common_retry(), onClick: retry },
			});
		},
	});
	const context = createWorkspaceContextStore(deps.chatSessions, deps.modelCatalog);
	let placement: WorkspaceCoordinator | null = null;
	const terminals = new TerminalRegistry({
		getToken: getAuthToken,
		getAuthDisabled: () => deps.auth.authDisabled,
		getClientId: () => {
			if (!deps.terminalIdentity.clientId) {
				throw new Error('Terminal client identity is not ready');
			}
			return deps.terminalIdentity.clientId;
		},
		onSessionTerminated: (terminalId) => {
			const coordinator = placement;
			if (!coordinator) return;
			void coordinator.handleTerminalSessionTerminated(terminalId).catch(() => {
				deps.notifications.error(m.terminal_session_cleanup_failed());
			});
		},
	});
	const chatInteractionGate = new ChatInteractionGate();
	const transientLayers = new TransientLayerRegistry(chatInteractionGate);
	const surfaceFrames = new SurfaceFrameRegistry();
	const gitQuickSummary = new GitQuickSummaryStore();
	const gitMutations = new GitMutationCoordinator({
		onChanged: async (effectiveProjectKey) => {
			gitProjectInvalidations.markChanged(effectiveProjectKey);
			if (context.currentProject?.effectiveProjectKey === effectiveProjectKey) {
				await gitQuickSummary.refresh('invalidation');
			}
		},
		onInvalidationError: (error, _effectiveProjectKey, projectPath) => {
			deps.notifications.error(
				m.git_related_refresh_failed({
					projectPath,
					detail: error instanceof Error ? error.message : String(error),
				}),
			);
		},
	});
	const gitBranchActions = new GitBranchSelectorState({
		openMainInert: (commitOpen) => transientLayers.open('main-inert', commitOpen),
		runMutation: (surfaceId, projectPath, effectiveProjectKey, execute) =>
			gitMutations.run({
				surfaceId,
				effectiveProjectKey,
				projectPath,
				execute,
				didMutate: (result) => result.success,
			}),
	});
	const singletonSurfaces = new SingletonSurfaceRegistry({
		createCommit: () =>
			new CommitController({
				runMutation: (request) =>
					gitMutations.run({
						surfaceId: 'singleton:commit',
						...request,
					}),
			}),
		createPullRequests: () =>
			createPullRequestsStore({
				notifyError: (message) => deps.notifications.error(message),
			}),
		gitBranchActions,
		gitMutations,
		getCurrentEffectiveProjectKey: () => context.currentProject?.effectiveProjectKey ?? null,
	});
	const domainBindings = new WorkspaceDomainBindings({
		workspaceContext: context,
		chatSessions: deps.chatSessions,
		ghCapability: deps.ghCapability,
		localSettings: deps.localSettings,
		singletons: singletonSurfaces,
		gitQuickSummary,
		gitBranchActions,
	});

	const files: FileSessionRegistry = new FileSessionRegistry({
		getIsMobile: () => deps.appShell.isMobile,
		getEditorSettings: () => ({
			get wordWrap() {
				return deps.localSettings.codeEditorWordWrap;
			},
			get showLineNumbers() {
				return deps.localSettings.codeEditorLineNumbers;
			},
			get fontSize() {
				return Number.parseInt(deps.localSettings.codeEditorFontSize, 10) || 12;
			},
		}),
		getPlacement: (): WorkspaceCoordinator => {
			if (!placement) throw new Error('Workspace placement is not ready');
			return placement;
		},
		openMainInert: (commitOpen) => transientLayers.open('main-inert', commitOpen),
	});
	const coordinator = new WorkspaceCoordinator({
		arbiter: new WorkspaceTransitionArbiter(layout, layout),
		terminals,
		workspaceContext: context,
		appShell: deps.appShell,
		chatSessions: deps.chatSessions,
		chatInteractionGate,
		transientLayers,
		files,
		singletons: singletonSurfaces,
		gitMutations,
		surfaceFrames,
		onLayoutChanged: (snapshot) => persistence.schedule(snapshot),
		onTerminalLauncherDismissed: deps.onTerminalLauncherDismissed,
		getRouteIdentity: deps.getRouteIdentity,
	});
	placement = coordinator;
	const shortcuts = new WorkspaceShortcutDispatcher({
		workspace: coordinator,
		transients: transientLayers,
		appShell: deps.appShell,
		navigation: deps.navigation,
		files,
	});

	return {
		restore,
		layout,
		context,
		terminals,
		chatInteractionGate,
		transientLayers,
		surfaceFrames,
		gitQuickSummary,
		gitMutations,
		gitBranchActions,
		singletonSurfaces,
		files,
		coordinator,
		shortcuts,
		destroy() {
			domainBindings.destroy();
			terminals.destroy();
			surfaceFrames.destroy();
			singletonSurfaces.destroy();
			gitQuickSummary.destroy();
			gitBranchActions.destroy();
			persistence.destroy();
		},
	};
}
