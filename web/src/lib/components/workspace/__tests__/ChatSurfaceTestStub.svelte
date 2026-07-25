<script lang="ts">
	import { onMount } from 'svelte';
	import type { SubagentManagementModel } from '$lib/chat/transcript/subagent-management.js';
	import type { SubagentToolbarState } from '$lib/chat/transcript/subagent-toolbar-state.svelte.js';
	import type { UserMessageNavigatorRegistration } from '$lib/chat/transcript/user-message-navigator-controller.svelte.js';

	let {
		reserveTopFloatingToolbar,
		subagentToolbar,
		onRegisterUserMessageNavigator,
	}: {
		reserveTopFloatingToolbar: boolean;
		subagentToolbar: SubagentToolbarState;
		onRegisterUserMessageNavigator?: (command: UserMessageNavigatorRegistration) => void;
	} = $props();
	let navigatorOpenCount = $state(0);
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
>
	Chat surface
	<input aria-label="Chat focus target" />
</div>
