<script lang="ts">
	import type { AgentSwitchMessage } from '$shared/chat-types';
	import { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte';
	import { setModelCatalog } from '$lib/context';
	import AgentSwitchRow from '../AgentSwitchRow.svelte';

	let { message, labels }: { message: AgentSwitchMessage; labels: Record<string, string> } = $props();

	class TestModelCatalogStore extends ModelCatalogStore {
		override getAgentLabel(agentId: string): string {
			return labels[agentId] ?? agentId;
		}
	}

	setModelCatalog(new TestModelCatalogStore());
</script>

<AgentSwitchRow {message} />
