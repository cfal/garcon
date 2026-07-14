import MessageSquare from '@lucide/svelte/icons/message-square';
import FolderOpen from '@lucide/svelte/icons/folder-open';
import Terminal from '@lucide/svelte/icons/terminal';
import GitBranch from '@lucide/svelte/icons/git-branch';
import GitPullRequest from '@lucide/svelte/icons/git-pull-request';
import * as m from '$lib/paraglide/messages.js';
export type MobileWorkspaceTabId = 'chat' | 'files' | 'terminal' | 'git' | 'pull-requests';

export type MobileWorkspaceTabDefinition = {
	id: MobileWorkspaceTabId;
	label: () => string;
	icon: typeof MessageSquare;
};

export const MOBILE_WORKSPACE_TABS: MobileWorkspaceTabDefinition[] = [
	{ id: 'chat', label: m.sidebar_navigation_chat, icon: MessageSquare },
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
