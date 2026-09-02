<script lang="ts">
	import { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte';
	import { setModelCatalog } from '$lib/context';
	import type { ScheduledPrompt } from '$shared/scheduled-prompts';
	import ScheduledPromptRow from '../ScheduledPromptRow.svelte';

	interface Props {
		scheduledPrompt: ScheduledPrompt;
		currentTime: Date;
		index: number;
		total: number;
		onEdit: () => void;
		onRemove: () => void;
		onMoveUp: () => void;
		onMoveDown: () => void;
	}

	let props: Props = $props();

	class TestModelCatalogStore extends ModelCatalogStore {
		override getAgentLabel(agentId: string): string {
			return agentId === 'codex' ? 'Codex' : agentId;
		}
	}

	setModelCatalog(new TestModelCatalogStore());
</script>

<ScheduledPromptRow {...props} />
