import { untrack } from 'svelte';
import { page } from '$app/state';
import { appPathname } from '$lib/deployment/paths';
import {
	getChatSessions,
	getNotifications,
	getSingletonSurfaces,
	getWorkspaceCoordinator,
} from '$lib/context';
import * as m from '$lib/paraglide/messages.js';
import { selectedTicketFromUrl } from '$lib/tickets/catalog/ticket-deep-link.js';
import { restoreChatIdForBareRoute, selectedChatIdFromRoute } from './app-shell-route';
import { shouldSynchronizeFocusedChat } from './app-shell-chat-navigation';
import type { AppShellChatNavigationController } from './app-shell-chat-navigation-controller.svelte.js';

export function bindAppShellRoute(
	chatNavigation: AppShellChatNavigationController,
	options?: { hasFocusedWorkflow?: () => boolean },
): void {
	const sessions = getChatSessions();
	const notifications = getNotifications();
	const workspace = getWorkspaceCoordinator();
	const singletonSurfaces = getSingletonSurfaces();
	const routeTicketId = $derived(selectedTicketFromUrl(page.url));
	let handledTicketLink: string | null = null;

	$effect(() => {
		const id = routeTicketId;
		if (!id) {
			handledTicketLink = null;
			return;
		}
		if (id === handledTicketLink) return;
		handledTicketLink = id;
		let canceled = false;
		untrack(() => {
			void workspace
				.openSingletonAsTab('tickets', workspace.currentWindowId)
				.then(() => {
					if (!canceled) singletonSurfaces.tickets().select(id);
				})
				.catch((error) =>
					notifications.error(error instanceof Error ? error.message : m.workspace_open_failed()),
				);
		});
		return () => {
			canceled = true;
		};
	});

	$effect(() => {
		if (routeTicketId) return;
		const chatId = page.params.id as string | undefined;
		const selectedChatId = selectedChatIdFromRoute(appPathname(page.url.pathname), chatId);
		if (selectedChatId === undefined) return;
		untrack(() => chatNavigation.handleRouteChat(selectedChatId));
	});

	$effect(() => {
		if (routeTicketId || options?.hasFocusedWorkflow?.()) return;
		const lastSelectedChatId = sessions.lastSelectedChatId;
		const target = restoreChatIdForBareRoute({
			pathname: appPathname(page.url.pathname),
			routeChatId: page.params.id as string | undefined,
			isLoadingChats: sessions.isLoadingChats,
			lastSelectedChatId,
			lastSelectedChatExists: lastSelectedChatId ? sessions.hasChat(lastSelectedChatId) : false,
			selectedChatId: sessions.selectedChatId,
		});
		if (!target) return;
		untrack(() => void chatNavigation.showChatInCurrentWindow(target, { navigate: true }));
	});

	$effect(() => {
		const currentWindowId = workspace.currentWindowId;
		const chatId = workspace.focusedChatId;
		if (
			!chatId ||
			!shouldSynchronizeFocusedChat({
				focusedWindowId: currentWindowId,
				focusedChatId: chatId,
				focusedChatExists: sessions.hasChat(chatId),
				selectedChatId: sessions.selectedChatId,
				pendingChatTarget: chatNavigation.pendingChatTarget,
				pendingWindowId: chatNavigation.pendingWindowId,
			})
		) {
			return;
		}
		untrack(() => void chatNavigation.synchronizeFocusedChat(chatId));
	});

	$effect(() => {
		const selected = sessions.selectedChat;
		if (!selected || selected.status === 'draft') return;
		const chatId = selected.id;
		untrack(() => sessions.rememberSelectedChat(chatId));
	});
}
