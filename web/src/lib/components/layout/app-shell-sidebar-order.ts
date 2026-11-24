import {
	getChatSessions,
	getExecutors,
	getLocalSettings,
	getMinuteClock,
	getNotifications,
	getRemoteSettings,
	getSidebarProjectCollapse,
	getSidebarSearch,
	setSidebarOrder,
} from '$lib/context';
import { reorderChat, sortChatOrder } from '$lib/api/chats';
import { SidebarOrderController } from '$lib/sidebar/display/sidebar-order-controller.svelte';
import { sidebarOrderErrorMessage } from '../sidebar/sidebar-order-notifications';

export function createAppShellSidebarOrder(): SidebarOrderController {
	const sessions = getChatSessions();
	const executors = getExecutors();
	const localSettings = getLocalSettings();
	const minuteClock = getMinuteClock();
	const notifications = getNotifications();
	const remoteSettings = getRemoteSettings();
	const projectCollapse = getSidebarProjectCollapse();
	const sidebarSearch = getSidebarSearch();
	const controller = new SidebarOrderController({
		get input() {
			return {
				allChats: sessions.orderedChats,
				matchingChatIds: sidebarSearch.activeQuery.trim()
					? new Set(sidebarSearch.filteredChats.map((chat) => chat.id))
					: undefined,
				executorOrder: executors.executors.map((executor) => executor.id),
				groupingFields: localSettings.sidebarGroupingFields,
				nestDelegatedChats: localSettings.sidebarNestDelegatedChats,
				separateArchivedBranches: localSettings.sidebarSeparateArchivedBranches,
				currentTime: minuteClock.currentTime,
				inactivityDuration: localSettings.sidebarInactivityDuration,
				sortMode: localSettings.sidebarSortMode,
				pinnedInsertPosition: remoteSettings.snapshot?.ui?.pinnedInsertPosition ?? 'top',
				isChatOptimisticallyArchived: (chatId: string) =>
					sessions.isChatOptimisticallyArchived(chatId),
				groupNestedProjectPaths: localSettings.sidebarGroupNestedProjectPaths,
				collapsedProjectKeys: projectCollapse.collapsedProjectKeys,
				expandedDelegationKeys: projectCollapse.expandedDelegationKeys,
				collapseDelegatedChatsByDefault: localSettings.collapseDelegatedChatsByDefault,
			};
		},
		write: reorderChat,
		refresh: () => sessions.refreshOrderSnapshot(),
		sort: (sortKey) => sortChatOrder({ sortKey }),
		onError: (_error, outcome) => notifications.error(sidebarOrderErrorMessage(outcome)),
	});
	setSidebarOrder(controller);
	return controller;
}
