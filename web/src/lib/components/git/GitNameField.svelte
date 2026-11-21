<script lang="ts">
	import { tick } from 'svelte';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import WandSparkles from '@lucide/svelte/icons/wand-sparkles';
	import { GIT_NAME_DESCRIPTION_LIMIT, GIT_NAME_LIMIT } from '$shared/git-name';
	import { generateGitName } from '$lib/api/git-name.js';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		name: string;
		contextKey?: string;
		description?: string;
		disabled: boolean;
		placeholder: string;
		ref?: HTMLInputElement | null;
		generating?: boolean;
		onChange: (name: string, origin: 'typed' | 'suggested') => void;
		onEnter: () => void;
	}
	let {
		name,
		contextKey = '',
		description = '',
		disabled,
		placeholder,
		ref = $bindable(null),
		generating = $bindable(false),
		onChange,
		onEnter,
	}: Props = $props();
	const id = $props.id();
	let request: AbortController | null = null;
	let error = $state('');

	function cancel() {
		request?.abort();
		request = null;
		generating = false;
		error = '';
	}

	$effect(() => {
		contextKey;
		description;
		return cancel;
	});

	async function suggest(event: MouseEvent) {
		if (disabled || request) return;
		const trigger = event.currentTarget;
		const previous = name;
		const target = contextKey;
		const task = description;
		const abort = new AbortController();
		request = abort;
		generating = true;
		error = '';
		const current = () =>
			!abort.signal.aborted &&
			!disabled &&
			target === contextKey &&
			task === description &&
			previous === name;
		try {
			const result = await generateGitName(
				{
					description: (task.trim() || previous.trim()).slice(0, GIT_NAME_DESCRIPTION_LIMIT),
					previousName: previous.slice(0, GIT_NAME_LIMIT),
				},
				abort.signal,
			);
			if (!current()) return;
			onChange(result.name, 'suggested');
			await tick();
			if (
				request === abort &&
				ref?.value === result.name &&
				(document.activeElement === trigger || document.activeElement === ref)
			) {
				ref.focus();
				ref.select();
			}
		} catch {
			if (current()) error = m.git_name_generation_error();
		} finally {
			if (request === abort) {
				request = null;
				generating = false;
			}
		}
	}
</script>

<div class="space-y-1.5">
	<label for={id} class="block text-sm font-medium">{m.git_new_branch_branch_name()}</label>
	<div class="flex items-center gap-2">
		<input
			{id}
			bind:this={ref}
			value={name}
			{placeholder}
			{disabled}
			autocomplete="off"
			autocapitalize="off"
			spellcheck="false"
			aria-describedby={error ? id + '-error' : undefined}
			class="h-10 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:pointer-fine:text-sm"
			oninput={(event) => {
				cancel();
				onChange(event.currentTarget.value, 'typed');
			}}
			onkeydown={(event) => {
				if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
				event.preventDefault();
				if (!disabled && !generating) onEnter();
			}}
		/>
		<button
			type="button"
			{disabled}
			aria-disabled={disabled || generating}
			aria-busy={generating}
			aria-label={m.git_name_generate()}
			title={m.git_name_generate()}
			onclick={suggest}
			class="inline-flex h-10 shrink-0 items-center gap-2 rounded-md border border-border px-3 text-sm text-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-disabled:opacity-50"
		>
			{#if generating}<LoaderCircle class="size-4 animate-spin" />{:else}<WandSparkles
					class="size-4"
				/>{/if}
			<span>{m.git_name_generate()}</span>
		</button>
	</div>
	{#if error}<p id={id + '-error'} role="alert" class="text-xs text-destructive">{error}</p>{/if}
</div>
