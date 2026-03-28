<script lang="ts">
	import { cn } from '$lib/utils/cn';
	import type { SessionProvider } from '$lib/types/app';
	import * as m from '$lib/paraglide/messages.js';

	type ProviderBadgeAppearance = 'pill' | 'plain';
	type ProviderBadgeSize = 'sm' | 'md';

	interface ProviderBadgeProps {
		provider: SessionProvider;
		appearance?: ProviderBadgeAppearance;
		size?: ProviderBadgeSize;
		showLabel?: boolean;
		class?: string;
		labelClass?: string;
	}

	let {
		provider,
		appearance = 'pill',
		size = 'sm',
		showLabel = true,
		class: className,
		labelClass = '',
	}: ProviderBadgeProps = $props();

	const PROVIDER_TONES: Record<
		SessionProvider,
		{
			pill: string;
			icon: string;
		}
	> = {
		claude: {
			pill: 'border-provider-claude-border bg-provider-claude-bg text-provider-claude-foreground',
			icon: 'border-provider-claude-border/60 bg-provider-claude-bg text-provider-claude-foreground',
		},
		codex: {
			pill: 'border-provider-codex-border bg-provider-codex-bg text-provider-codex-foreground',
			icon: 'border-provider-codex-border/60 bg-provider-codex-bg text-provider-codex-foreground',
		},
		opencode: {
			pill: 'border-provider-opencode-border bg-provider-opencode-bg text-provider-opencode-foreground',
			icon: 'border-provider-opencode-border/60 bg-provider-opencode-bg text-provider-opencode-foreground',
		},
		amp: {
			pill: 'border-provider-amp-border bg-provider-amp-bg text-provider-amp-foreground',
			icon: 'border-provider-amp-border/60 bg-provider-amp-bg text-provider-amp-foreground',
		},
	};

	const label = $derived(
		provider === 'codex'
			? m.provider_codex()
			: provider === 'opencode'
				? m.provider_opencode()
				: provider === 'amp'
					? m.provider_amp()
					: m.provider_claude(),
	);
	const outerClass = $derived(
		appearance === 'pill'
			? size === 'md'
				? 'inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-semibold leading-none'
				: 'inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-semibold leading-none'
			: size === 'md'
				? 'inline-flex items-center gap-2 text-sm font-medium leading-none'
				: 'inline-flex items-center gap-1.5 text-xs font-medium leading-none',
	);
	const iconClass = $derived(
		size === 'md'
			? 'inline-flex size-6 items-center justify-center rounded-full border'
			: 'inline-flex size-5 items-center justify-center rounded-full border',
	);
	const iconSizeClass = $derived(size === 'md' ? 'size-3.5' : 'size-3');
	const textClass = $derived(appearance === 'pill' ? '' : 'text-foreground');
</script>

<span class={cn(outerClass, appearance === 'pill' ? PROVIDER_TONES[provider].pill : textClass, className)}>
	<span class={cn(iconClass, PROVIDER_TONES[provider].icon)} aria-hidden="true">
		{#if provider === 'claude'}
			<svg viewBox="0 0 16 16" class={iconSizeClass} fill="currentColor">
				<path d="M8 1.6 9.32 5l3.42 1.3-3.42 1.3L8 11 6.68 7.6 3.26 6.3 6.68 5z" />
			</svg>
		{:else if provider === 'codex'}
			<svg viewBox="0 0 16 16" class={iconSizeClass} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
				<path d="M6.25 3.5 2.75 8l3.5 4.5" />
				<path d="M9.75 3.5 13.25 8l-3.5 4.5" />
			</svg>
		{:else if provider === 'opencode'}
			<svg viewBox="0 0 16 16" class={iconSizeClass} fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
				<rect x="2.75" y="2.75" width="4.5" height="4.5" rx="1.2" />
				<rect x="8.75" y="8.75" width="4.5" height="4.5" rx="1.2" />
				<path d="M7.25 8.75 8.75 7.25" />
			</svg>
		{:else}
			<svg viewBox="0 0 16 16" class={iconSizeClass} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
				<path d="M2.2 8h2.45L6 4.8 8.35 11l1.55-3h3.95" />
			</svg>
		{/if}
	</span>
	{#if showLabel}
		<span class={cn('truncate', labelClass)}>{label}</span>
	{/if}
</span>
