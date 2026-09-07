<script lang="ts">
	import {
		ChatReconnectCoordinator,
		type ChatReconnectCoordinatorOptions,
	} from '../reconnect-coordinator.svelte.js';

	let { options }: { options: ChatReconnectCoordinatorOptions } = $props();

	function mountCoordinator(): void {
		new ChatReconnectCoordinator(options).mount();
	}

	mountCoordinator();
</script>
