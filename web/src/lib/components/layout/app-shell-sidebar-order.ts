import { untrack } from 'svelte';
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
			const groupingFields = localSettings.sidebarGroupingFields;
			const groupByActivity = groupingFields.some(
				({ field, enabled }) => field === 'activity' && enabled,
			);
			return {
				allChats: sessions.orderedChats,
				matchingChatIds: sidebarSearch.activeQuery.trim()
					? new Set(sidebarSearch.filteredChats.map((chat) => chat.id))
					: undefined,
				executorOrder: executors.executors.map((executor) => executor.id),
				groupingFields,
				nestDelegatedChats: localSettings.sidebarNestDelegatedChats,
				separateArchivedBranches: localSettings.sidebarSeparateArchivedBranches,
				// Relative labels observe the clock independently of row ordering.
				currentTime: groupByActivity
					? minuteClock.currentTime
					: untrack(() => minuteClock.currentTime),
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
