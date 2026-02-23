// Typed context factories for dependency injection across the component tree.
// Replaces string-keyed getContext/setContext with compile-time-safe accessors.

import { createContext } from 'svelte';
import type { AuthStore } from '$lib/stores/auth.svelte';
import type { PreferencesStore } from '$lib/stores/preferences.svelte';
import type { NavigationStore } from '$lib/stores/navigation.svelte';
import type { ChatRuntimeStore } from '$lib/stores/chat-runtime.svelte';
import type { ChatSessionsStore } from '$lib/stores/chat-sessions.svelte';
import type { AppShellStore } from '$lib/stores/app-shell.svelte';
import type { WsConnection } from '$lib/ws/connection.svelte';
import type { ChatState } from '$lib/chat/state.svelte';
import type { ComposerState } from '$lib/chat/composer.svelte';
import type { ProviderState } from '$lib/chat/provider-state.svelte';
import type { ChatLifecycleStore } from '$lib/stores/chat-lifecycle.svelte';
import type { FileOpenStore } from '$lib/stores/file-open.svelte';
import type { ReadReceiptOutboxStore } from '$lib/stores/read-receipt-outbox.svelte';

// Root-level contexts (set in +layout.svelte)
export const [getAuth, setAuth] = createContext<AuthStore>();
export const [getPreferences, setPreferences] = createContext<PreferencesStore>();
export const [getNavigation, setNavigation] = createContext<NavigationStore>();
export const [getChatRuntime, setChatRuntime] = createContext<ChatRuntimeStore>();
export const [getChatSessions, setChatSessions] = createContext<ChatSessionsStore>();
export const [getAppShell, setAppShell] = createContext<AppShellStore>();
export const [getWs, setWs] = createContext<WsConnection>();
export const [getFileOpen, setFileOpen] = createContext<FileOpenStore>();
export const [getReadReceiptOutbox, setReadReceiptOutbox] = createContext<ReadReceiptOutboxStore>();

// Chat-level contexts (set in ConversationWorkspace.svelte)
export const [getChatState, setChatState] = createContext<ChatState>();
export const [getComposerState, setComposerState] = createContext<ComposerState>();
export const [getProviderState, setProviderState] = createContext<ProviderState>();
export const [getChatLifecycle, setChatLifecycle] = createContext<ChatLifecycleStore>();
