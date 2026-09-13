<script lang="ts">
	import type { SearchResultNavigationPort } from '$lib/sidebar/search/search-result-navigation-controller.js';
	import { searchNavigationPort } from './app-shell-search-navigation-test-port.js';
	let {
		isMobile,
		onRegisterSearchNavigation,
	}: {
		isMobile: boolean;
		onRegisterSearchNavigation?: (port: SearchResultNavigationPort) => () => void;
	} = $props();
	$effect(() => onRegisterSearchNavigation?.(searchNavigationPort));
</script>

<div data-testid="workspace-root-stub" data-mobile={isMobile}>Workspace root</div>
