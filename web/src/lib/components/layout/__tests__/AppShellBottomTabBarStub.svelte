<script lang="ts">
	import type { MobileWorkspaceTabId } from '$lib/components/workspace/mobile-workspace-tabs';

	let {
		activeItem,
		onTabChange,
		onMenuClick,
	}: {
		activeItem: MobileWorkspaceTabId;
		onTabChange: (tab: MobileWorkspaceTabId) => void;
		onMenuClick: () => void;
	} = $props();
</script>

<div data-testid="bottom-tab-bar-stub" data-active-item={activeItem}>
	<button type="button" onclick={onMenuClick}>Open chat drawer</button>
	<button type="button" onclick={() => onTabChange('chat-map')}>Select Map tab</button>
</div>
