<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import { cn } from '$lib/utils/cn';
	import * as m from '$lib/paraglide/messages.js';

	let {
		id,
		value = $bindable(''),
		disabled = false,
		class: className,
		...props
	}: Omit<HTMLInputAttributes, 'type' | 'value' | 'files'> & { id: string; value?: string } = $props();
	let revealed = $state(false);
	const toggleLabel = $derived(revealed ? m.auth_password_hide() : m.auth_password_show());

	$effect(() => {
		if (!value || disabled) revealed = false;
	});
</script>

<div class="relative">
	<Input
		{...props}
		{id}
		bind:value
		{disabled}
		type={revealed ? 'text' : 'password'}
		class={cn('pr-10', className)}
	/>
	<Button
		type="button"
		variant="ghost"
		size="icon"
		class="absolute right-0 top-0 h-full"
		{disabled}
		onclick={() => (revealed = !revealed)}
		aria-controls={id}
		aria-label={toggleLabel}
		title={toggleLabel}
	>
		{#if revealed}<EyeOff class="size-4" />{:else}<Eye class="size-4" />{/if}
	</Button>
</div>
