<script lang="ts">
	import type { SearchResultSelection } from '$lib/sidebar/search/search-result-navigation-controller.js';
	let { onSelectResult }: { onSelectResult(selection: SearchResultSelection): void } = $props();
</script>

<button onclick={() => onSelectResult({ chatId: 'first', target: null })}
	>First search result</button
>
<button onclick={() => onSelectResult({ chatId: 'second', target: null })}
	>Second search result</button
>
