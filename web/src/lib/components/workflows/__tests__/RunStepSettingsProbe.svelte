<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import type WorkflowStepSettings from '../WorkflowStepSettings.svelte';

	let { step, onApply }: ComponentProps<typeof WorkflowStepSettings> = $props();
</script>

<output>{step.kind === 'command' ? step.shell : step.model}</output>
<button type="button" onclick={() => onApply({ shell: 'bash' })}>Choose bash</button>
