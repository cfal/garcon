import MessageSquare from '@lucide/svelte/icons/message-square';
import FolderOpen from '@lucide/svelte/icons/folder-open';
import Terminal from '@lucide/svelte/icons/terminal';
import GitBranch from '@lucide/svelte/icons/git-branch';
import GitPullRequest from '@lucide/svelte/icons/git-pull-request';
import * as m from '$lib/paraglide/messages.js';
import type { AppTab } from '$lib/types/app';

export type ChatToolbarTabId = Extract<
	AppTab,
	'chat' | 'files' | 'shell' | 'git' | 'pull-requests'
>;

export type ChatToolbarTabDef = {
	id: ChatToolbarTabId;
	label: () => string;
	icon: typeof MessageSquare;
};

export const CHAT_TOOLBAR_TABS: ChatToolbarTabDef[] = [
	{ id: 'chat', label: m.sidebar_navigation_chat, icon: MessageSquare },
	{ id: 'git', label: m.sidebar_navigation_git, icon: GitBranch },
	{ id: 'pull-requests', label: m.sidebar_navigation_pull_requests, icon: GitPullRequest },
	{ id: 'files', label: m.sidebar_navigation_files, icon: FolderOpen },
	{ id: 'shell', label: m.sidebar_navigation_terminal, icon: Terminal },
];
