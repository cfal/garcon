import MessageSquare from '@lucide/svelte/icons/message-square';
import FolderOpen from '@lucide/svelte/icons/folder-open';
import Terminal from '@lucide/svelte/icons/terminal';
import GitBranch from '@lucide/svelte/icons/git-branch';
import GitPullRequest from '@lucide/svelte/icons/git-pull-request';
import Waypoints from '@lucide/svelte/icons/waypoints';
import PanelsTopLeft from '@lucide/svelte/icons/panels-top-left';
import * as m from '$lib/paraglide/messages.js';
export type MobileWorkspaceTabId =
	'chat' | 'chat-map' | 'chat-canvas' | 'files' | 'terminal' | 'git' | 'pull-requests';

export type MobileWorkspaceTabDefinition = {
	id: MobileWorkspaceTabId;
	label: () => string;
	icon: typeof MessageSquare;
};

export const MOBILE_WORKSPACE_TABS: MobileWorkspaceTabDefinition[] = [
	{ id: 'chat', label: m.sidebar_navigation_chat, icon: MessageSquare },
	{ id: 'chat-map', label: m.workspace_surface_chat_map_short, icon: Waypoints },
	{ id: 'chat-canvas', label: m.workspace_surface_chat_canvas, icon: PanelsTopLeft },
	{ id: 'git', label: m.sidebar_navigation_git, icon: GitBranch },
	{ id: 'pull-requests', label: m.sidebar_navigation_pull_requests, icon: GitPullRequest },
	{ id: 'files', label: m.sidebar_navigation_files, icon: FolderOpen },
	{ id: 'terminal', label: m.sidebar_navigation_terminal, icon: Terminal },
];

export function getMobileWorkspaceTabs(options: {
	pullRequestsAvailable: boolean;
}): MobileWorkspaceTabDefinition[] {
	if (options.pullRequestsAvailable) return MOBILE_WORKSPACE_TABS;
	return MOBILE_WORKSPACE_TABS.filter((tab) => tab.id !== 'pull-requests');
}
