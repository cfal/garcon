// Typed context factories for dependency injection across the component tree.
// Replaces string-keyed getContext/setContext with compile-time-safe accessors.

import { createContext } from 'svelte';
import type { AuthStore } from '$lib/stores/auth.svelte';
import type { LocalSettingsStore } from '$lib/stores/local-settings.svelte';
import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
import type { NavigationStore } from '$lib/stores/navigation.svelte';
import type { ChatSessionsStore } from '$lib/stores/chat-sessions.svelte';
import type { AppShellStore } from '$lib/stores/app-shell.svelte';
import type { WsConnection } from '$lib/ws/connection.svelte';
import type { ChatState } from '$lib/chat/state.svelte';
import type { ComposerState } from '$lib/chat/composer.svelte';
import type { AgentState } from '$lib/chat/agent-state.svelte';
import type { ChatLifecycleStore } from '$lib/stores/chat-lifecycle.svelte';
import type { FileSessionRegistry } from '$lib/stores/file-sessions.svelte';
import type { ReadReceiptOutboxStore } from '$lib/stores/read-receipt-outbox.svelte';
import type { ModelCatalogStore } from '$lib/stores/model-catalog.svelte';
import type { SplitLayoutStore } from '$lib/stores/split-layout.svelte';
import type { NotificationsStore } from '$lib/stores/notifications.svelte';
import type { SidebarSearchStore } from '$lib/stores/sidebar-search.svelte';
import type { SidebarProjectCollapseStore } from '$lib/stores/sidebar-project-collapse.svelte';
import type { AppTitleStore } from '$lib/stores/app-title.svelte';
import type { GhCapabilityContext } from '$lib/stores/gh-capability.svelte';
import type { ScheduledPromptsStore } from '$lib/stores/scheduled-prompts.svelte';
import type { WorkspaceLayoutReader } from '$lib/workspace/surface-types';
import type { WorkspaceContextStore } from '$lib/workspace/workspace-context.svelte';
import type { TerminalRegistry } from '$lib/stores/terminal-registry.svelte';
import type { WorkspaceCoordinator } from '$lib/workspace/workspace-coordinator.svelte';
import type { ChatInteractionGate } from '$lib/workspace/chat-interaction-gate.svelte';
import type { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte';
import type { SurfaceFrameRegistry } from '$lib/workspace/surface-frame-registry.svelte';
import type { WorkspaceShortcutDispatcher } from '$lib/workspace/workspace-shortcuts';
import type { GitQuickSummaryStore } from '$lib/stores/git/git-quick-summary.svelte';
import type { GitBranchSelectorState } from '$lib/stores/git/git-branch-selector-state.svelte';
import type { GitMutationCoordinator } from '$lib/stores/git/git-mutations.svelte';
import type { SingletonSurfaceRegistry } from '$lib/stores/singleton-surfaces.svelte';

// Root-level contexts (set in +layout.svelte)
export const [getAuth, setAuth] = createContext<AuthStore>();
export const [getNavigation, setNavigation] = createContext<NavigationStore>();
export const [getChatSessions, setChatSessions] = createContext<ChatSessionsStore>();
export const [getAppShell, setAppShell] = createContext<AppShellStore>();
export const [getWs, setWs] = createContext<WsConnection>();
export const [getFileSessions, setFileSessions] = createContext<FileSessionRegistry>();
export const [getReadReceiptOutbox, setReadReceiptOutbox] = createContext<ReadReceiptOutboxStore>();
export const [getModelCatalog, setModelCatalog] = createContext<ModelCatalogStore>();
export const [getSplitLayout, setSplitLayout] = createContext<SplitLayoutStore>();
export const [getNotifications, setNotifications] = createContext<NotificationsStore>();
export const [getSidebarSearch, setSidebarSearch] = createContext<SidebarSearchStore>();
export const [getGhCapability, setGhCapability] = createContext<GhCapabilityContext>();
export const [getSidebarProjectCollapse, setSidebarProjectCollapse] =
	createContext<SidebarProjectCollapseStore>();
export const [getAppTitle, setAppTitle] = createContext<AppTitleStore>();
export const [getScheduledPrompts, setScheduledPrompts] = createContext<ScheduledPromptsStore>();
export const [getWorkspaceLayout, setWorkspaceLayout] = createContext<WorkspaceLayoutReader>();
export const [getWorkspaceContext, setWorkspaceContext] = createContext<WorkspaceContextStore>();
export const [getTerminalRegistry, setTerminalRegistry] = createContext<TerminalRegistry>();
export const [getWorkspaceCoordinator, setWorkspaceCoordinator] =
	createContext<WorkspaceCoordinator>();
export const [getChatInteractionGate, setChatInteractionGate] =
	createContext<ChatInteractionGate>();
const [getRequiredTransientLayers, setTransientLayersContext] =
	createContext<TransientLayerRegistry>();
export const getTransientLayers = getRequiredTransientLayers;
export const setTransientLayers = setTransientLayersContext;
export function getOptionalTransientLayers(): TransientLayerRegistry | null {
	try {
		return getRequiredTransientLayers();
	} catch {
		return null;
	}
}
export const [getSurfaceFrames, setSurfaceFrames] = createContext<SurfaceFrameRegistry>();
export const [getWorkspaceShortcuts, setWorkspaceShortcuts] =
	createContext<WorkspaceShortcutDispatcher>();
export const [getGitQuickSummary, setGitQuickSummary] = createContext<GitQuickSummaryStore>();
export const [getGitBranchActions, setGitBranchActions] = createContext<GitBranchSelectorState>();
export const [getGitMutations, setGitMutations] = createContext<GitMutationCoordinator>();
export const [getSingletonSurfaces, setSingletonSurfaces] =
	createContext<SingletonSurfaceRegistry>();

export const [getLocalSettings, setLocalSettings] = createContext<LocalSettingsStore>();
export const [getRemoteSettings, setRemoteSettings] = createContext<RemoteSettingsStore>();

// Chat-level contexts (set in ConversationWorkspace.svelte)
export const [getChatState, setChatState] = createContext<ChatState>();
export const [getComposerState, setComposerState] = createContext<ComposerState>();
export const [getAgentState, setAgentState] = createContext<AgentState>();
export const [getChatLifecycle, setChatLifecycle] = createContext<ChatLifecycleStore>();
