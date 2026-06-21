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
import type { FileViewerStore } from '$lib/stores/file-viewer.svelte';
import type { ReadReceiptOutboxStore } from '$lib/stores/read-receipt-outbox.svelte';
import type { ModelCatalogStore } from '$lib/stores/model-catalog.svelte';
import type { SplitLayoutStore } from '$lib/stores/split-layout.svelte';
import type { NotificationsStore } from '$lib/stores/notifications.svelte';
import type { SidebarSearchStore } from '$lib/stores/sidebar-search.svelte';

// Root-level contexts (set in +layout.svelte)
export const [getAuth, setAuth] = createContext<AuthStore>();
export const [getNavigation, setNavigation] = createContext<NavigationStore>();
export const [getChatSessions, setChatSessions] = createContext<ChatSessionsStore>();
export const [getAppShell, setAppShell] = createContext<AppShellStore>();
export const [getWs, setWs] = createContext<WsConnection>();
export const [getFileViewer, setFileViewer] = createContext<FileViewerStore>();
export const [getReadReceiptOutbox, setReadReceiptOutbox] = createContext<ReadReceiptOutboxStore>();
export const [getModelCatalog, setModelCatalog] = createContext<ModelCatalogStore>();
export const [getSplitLayout, setSplitLayout] = createContext<SplitLayoutStore>();
export const [getNotifications, setNotifications] = createContext<NotificationsStore>();
export const [getSidebarSearch, setSidebarSearch] = createContext<SidebarSearchStore>();

export const [getLocalSettings, setLocalSettings] = createContext<LocalSettingsStore>();
export const [getRemoteSettings, setRemoteSettings] = createContext<RemoteSettingsStore>();

// Chat-level contexts (set in ConversationWorkspace.svelte)
export const [getChatState, setChatState] = createContext<ChatState>();
export const [getComposerState, setComposerState] = createContext<ComposerState>();
export const [getAgentState, setAgentState] = createContext<AgentState>();
export const [getChatLifecycle, setChatLifecycle] = createContext<ChatLifecycleStore>();
