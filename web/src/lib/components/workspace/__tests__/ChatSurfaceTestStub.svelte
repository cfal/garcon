<script lang="ts">
	import { onMount } from 'svelte';
	import type { SubagentManagementModel } from '$lib/chat/transcript/subagent-management.js';
	import type { SubagentToolbarState } from '$lib/chat/transcript/subagent-toolbar-state.svelte.js';
	import type { UserMessageNavigatorRegistration } from '$lib/chat/transcript/user-message-navigator-controller.svelte.js';
	import type { ChatDraftAppend } from '$lib/chat/composer/chat-draft-append.js';
	import type { ConversationPanelActions } from '$lib/components/chat/conversation-panel-actions.js';

	let {
		subagentToolbar,
		isVisible,
		isInteractive,
		onRegisterUserMessageNavigator,
		onRegisterAppendToDraft,
		onRegisterPanelActions,
	}: {
		subagentToolbar: SubagentToolbarState;
		isVisible: boolean;
		isInteractive: boolean;
		onRegisterUserMessageNavigator?: (command: UserMessageNavigatorRegistration) => void;
		onRegisterAppendToDraft?: (append: ChatDraftAppend) => void;
		onRegisterPanelActions?: (actions: ConversationPanelActions | null) => void;
	} = $props();
	let navigatorOpenCount = $state(0);
	let draft = $state('');
	let panelAction = $state('');
	function recordPanelAction(surfaceId: string, chatId: string, action: string): void {
		panelAction = `${surfaceId}:${chatId}:${action}`;
	}
	const panelActions = {
		reload: (surfaceId, chatId) => recordPanelAction(surfaceId, chatId, 'reload'),
		decidePermission: (surfaceId, chatId) => recordPanelAction(surfaceId, chatId, 'permission'),
		exitPlanMode: (surfaceId, chatId) => recordPanelAction(surfaceId, chatId, 'plan'),
		fork: (surfaceId, chatId) => recordPanelAction(surfaceId, chatId, 'fork'),
		generateTitle: async (surfaceId, chatId) => recordPanelAction(surfaceId, chatId, 'title'),
		interruptQueue: async (surfaceId, chatId) => recordPanelAction(surfaceId, chatId, 'interrupt'),
		steerQueue: async (surfaceId, chatId) => recordPanelAction(surfaceId, chatId, 'steer'),
		pauseQueue: async (surfaceId, chatId) => recordPanelAction(surfaceId, chatId, 'pause'),
		resumeQueue: async (surfaceId, chatId) => recordPanelAction(surfaceId, chatId, 'resume'),
		reportQueueControlError: (surfaceId, chatId) => recordPanelAction(surfaceId, chatId, 'queue-error'),
		editQueue: (surfaceId, chatId) => recordPanelAction(surfaceId, chatId, 'edit-queue'),
		openQueue: (surfaceId, chatId) => recordPanelAction(surfaceId, chatId, 'open-queue'),
		deleteQueue: async (surfaceId, chatId) => recordPanelAction(surfaceId, chatId, 'delete-queue'),
		stop: async (surfaceId, chatId) => recordPanelAction(surfaceId, chatId, 'stop'),
		openCommit: (surfaceId, chatId) => recordPanelAction(surfaceId, chatId, 'commit'),
		toggleBranch: (surfaceId, chatId) => recordPanelAction(surfaceId, chatId, 'toggle-branch'),
		closeBranch: (surfaceId, chatId) => recordPanelAction(surfaceId, chatId, 'close-branch'),
		createBranch: (surfaceId, chatId) => recordPanelAction(surfaceId, chatId, 'create-branch'),
		switchBranch: async (surfaceId, chatId) => recordPanelAction(surfaceId, chatId, 'switch-branch'),
		searchBranches: (surfaceId, chatId) => recordPanelAction(surfaceId, chatId, 'search-branch'),
		sortBranches: (surfaceId, chatId) => recordPanelAction(surfaceId, chatId, 'sort-branch'),
		closeSwitchBranchDialog: (surfaceId, chatId) =>
			recordPanelAction(surfaceId, chatId, 'close-switch-branch'),
	} satisfies ConversationPanelActions;
	const subagentModel: SubagentManagementModel = {
		entries: [
			{
				id: 'root',
				kind: 'root',
				name: 'Main chat',
				status: 'running',
				statusLabel: 'Running',
			},
			{
				id: 'test-agent',
				kind: 'subagent',
				name: 'test-agent',
				status: 'running',
				statusLabel: 'Running',
				anchorId: 'tool-input-test-agent',
			},
		],
		subagents: [
			{
				id: 'test-agent',
				kind: 'subagent',
				name: 'test-agent',
				status: 'running',
				statusLabel: 'Running',
				anchorId: 'tool-input-test-agent',
			},
		],
	};

	onMount(() => {
		onRegisterUserMessageNavigator?.(() => {
			navigatorOpenCount += 1;
		});
		onRegisterAppendToDraft?.((block) => {
			draft = draft ? `${draft}\n\n${block}` : block;
			return 'appended';
		});
		onRegisterPanelActions?.(panelActions);
		const unregisterSubagentToolbar = subagentToolbar.register({
			model: subagentModel,
			jumpToTool: () => {},
		});
		return () => {
			unregisterSubagentToolbar();
			onRegisterUserMessageNavigator?.(null);
			onRegisterPanelActions?.(null);
		};
	});
</script>

<div
	data-testid="chat-surface-stub"
	data-navigator-open-count={navigatorOpenCount}
	data-visible={isVisible}
		data-interactive={isInteractive}
		data-panel-action={panelAction}
>
	Chat surface
	<textarea aria-label="Chat focus target" bind:value={draft}></textarea>
</div>
