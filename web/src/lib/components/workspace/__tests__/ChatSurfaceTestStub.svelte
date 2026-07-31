<script lang="ts">
	import { onMount } from 'svelte';
	import type { SubagentManagementModel } from '$lib/chat/transcript/subagent-management.js';
	import type { SubagentToolbarState } from '$lib/chat/transcript/subagent-toolbar-state.svelte.js';
	import type { UserMessageNavigatorRegistration } from '$lib/chat/transcript/user-message-navigator-controller.svelte.js';
	import type { ChatDraftAppend } from '$lib/chat/composer/chat-draft-append.js';

	let {
		reserveTopFloatingToolbar,
		subagentToolbar,
		isVisible,
		isInteractive,
		onRegisterUserMessageNavigator,
		onRegisterAppendToDraft,
	}: {
		reserveTopFloatingToolbar: boolean;
		subagentToolbar: SubagentToolbarState;
		isVisible: boolean;
		isInteractive: boolean;
		onRegisterUserMessageNavigator?: (command: UserMessageNavigatorRegistration) => void;
		onRegisterAppendToDraft?: (append: ChatDraftAppend) => void;
	} = $props();
	let navigatorOpenCount = $state(0);
	let draft = $state('');
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
		const unregisterSubagentToolbar = subagentToolbar.register({
			model: subagentModel,
			jumpToTool: () => {},
		});
		return () => {
			unregisterSubagentToolbar();
			onRegisterUserMessageNavigator?.(null);
		};
	});
</script>

<div
	data-testid="chat-surface-stub"
	data-reserve-top-floating-toolbar={reserveTopFloatingToolbar}
	data-navigator-open-count={navigatorOpenCount}
	data-visible={isVisible}
	data-interactive={isInteractive}
>
	Chat surface
	<textarea aria-label="Chat focus target" bind:value={draft}></textarea>
</div>
