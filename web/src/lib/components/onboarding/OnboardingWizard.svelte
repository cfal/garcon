<!-- First-run setup wizard: theme, sidebar chat layout, and chat display
     preferences across paged steps. Selections persist immediately so each
     choice applies live behind the dialog. -->
<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import SunIcon from '@lucide/svelte/icons/sun';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import MonitorIcon from '@lucide/svelte/icons/monitor';
	import CheckIcon from '@lucide/svelte/icons/check';
	import { getAppShell, getLocalSettings } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import { cn } from '$lib/utils/cn.js';
	import type {
		ChatMaxWidth,
		SidebarChatItemLayout,
		ThemeMode,
	} from '$lib/stores/local-settings.svelte.js';
	import {
		OnboardingWizardState,
		type OnboardingPageId,
	} from './onboarding-wizard-state.svelte.js';
	import OnboardingChatLayoutPreview from './OnboardingChatLayoutPreview.svelte';

	const appShell = getAppShell();
	const ls = getLocalSettings();
	const wizard = new OnboardingWizardState({
		localSettings: ls,
		onClose: () => appShell.closeOnboardingWizard(),
		onOpenProviders: () => appShell.openSettings('providers'),
	});

	function handleOpenChange(open: boolean) {
		if (!open) appShell.closeOnboardingWizard();
	}

	let pageTitleElement = $state<HTMLElement | null>(null);

	function handleOpenAutoFocus(event: Event): void {
		event.preventDefault();
		pageTitleElement?.focus();
	}

	// Moves focus to the page heading on each step change so assistive
	// technology announces the new page; focus otherwise stays on Continue.
	$effect(() => {
		wizard.pageIndex;
		pageTitleElement?.focus();
	});

	const pageTitles: Record<OnboardingPageId, () => string> = {
		theme: m.onboarding_theme_title,
		'chat-layout': m.onboarding_layout_title,
		'chat-display': m.onboarding_chat_display_title,
		done: m.onboarding_done_title,
	};
	const pageDescriptions: Record<OnboardingPageId, () => string> = {
		theme: m.onboarding_theme_description,
		'chat-layout': m.onboarding_layout_description,
		'chat-display': m.onboarding_chat_display_description,
		done: m.onboarding_done_description,
	};

	const themeOptions: Array<{
		value: ThemeMode;
		label: () => string;
		hint: () => string;
		icon: typeof SunIcon;
	}> = [
		{
			value: 'system',
			label: m.settings_theme_system,
			hint: m.onboarding_theme_system_hint,
			icon: MonitorIcon,
		},
		{
			value: 'light',
			label: m.settings_theme_light,
			hint: m.onboarding_theme_light_hint,
			icon: SunIcon,
		},
		{
			value: 'dark',
			label: m.settings_theme_dark,
			hint: m.onboarding_theme_dark_hint,
			icon: MoonIcon,
		},
	];

	const layoutOptions: Array<{
		value: SidebarChatItemLayout;
		label: () => string;
		hint: () => string;
	}> = [
		{
			value: 'compact',
			label: m.onboarding_layout_compact,
			hint: m.onboarding_layout_compact_hint,
		},
		{
			value: 'single-line',
			label: m.onboarding_layout_single_line,
			hint: m.onboarding_layout_single_line_hint,
		},
		{
			value: 'default',
			label: m.onboarding_layout_detailed,
			hint: m.onboarding_layout_detailed_hint,
		},
	];

	const chatMaxWidthOptions: Array<{
		value: ChatMaxWidth;
		label: () => string;
		previewClass: string;
	}> = [
		{ value: 'none', label: m.settings_chat_max_width_none, previewClass: 'w-full' },
		{ value: 'large', label: m.settings_chat_max_width_large, previewClass: 'w-4/5' },
		{ value: 'medium', label: m.settings_chat_max_width_medium, previewClass: 'w-3/5' },
		{ value: 'small', label: m.settings_chat_max_width_small, previewClass: 'w-2/5' },
	];

	const optionCardClass =
		'flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-border bg-card p-3 text-center transition-colors hover:border-primary/50 has-checked:border-primary has-checked:bg-accent/50 has-checked:shadow-xs has-focus-visible:ring-2 has-focus-visible:ring-ring has-focus-visible:ring-offset-1 has-focus-visible:ring-offset-background';
</script>

<Dialog.Root open={appShell.showOnboardingWizard} onOpenChange={handleOpenChange}>
	<Dialog.Content
		class="max-h-[85vh] overflow-y-auto sm:max-w-xl"
		aria-describedby="onboarding-description"
		onOpenAutoFocus={handleOpenAutoFocus}
	>
		<Dialog.Header>
			<p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{m.onboarding_wizard_title()}
			</p>
			<Dialog.Title
				bind:ref={pageTitleElement}
				tabindex={-1}
				class="text-xl font-semibold outline-none">{pageTitles[wizard.pageId]()}</Dialog.Title
			>
			<Dialog.Description id="onboarding-description">
				{pageDescriptions[wizard.pageId]()}
			</Dialog.Description>
		</Dialog.Header>

		<div class="min-h-40">
			{#if wizard.pageId === 'theme'}
				<fieldset class="grid grid-cols-1 gap-3 sm:grid-cols-3">
					<legend class="sr-only">{m.onboarding_theme_title()}</legend>
					{#each themeOptions as option (option.value)}
						<label class={optionCardClass}>
							<input
								type="radio"
								class="sr-only"
								name="onboarding-theme"
								value={option.value}
								checked={ls.theme === option.value}
								onchange={() => wizard.selectTheme(option.value)}
							/>
							<option.icon class="size-6 text-muted-foreground" />
							<span class="text-sm font-medium text-foreground">{option.label()}</span>
							<span class="text-xs text-muted-foreground">{option.hint()}</span>
						</label>
					{/each}
				</fieldset>
			{:else if wizard.pageId === 'chat-layout'}
				<fieldset class="grid grid-cols-1 gap-3 sm:grid-cols-3">
					<legend class="sr-only">{m.onboarding_layout_title()}</legend>
					{#each layoutOptions as option (option.value)}
						<label class={optionCardClass}>
							<input
								type="radio"
								class="sr-only"
								name="onboarding-layout"
								value={option.value}
								checked={ls.sidebarChatItemLayout === option.value}
								onchange={() => wizard.selectChatItemLayout(option.value)}
							/>
							<div class="flex w-full flex-1 items-center">
								<OnboardingChatLayoutPreview
									layout={option.value}
									isSelected={ls.sidebarChatItemLayout === option.value}
								/>
							</div>
							<span class="flex flex-col items-center gap-1">
								<span class="text-sm font-medium text-foreground">{option.label()}</span>
								<span class="text-xs text-muted-foreground">{option.hint()}</span>
							</span>
						</label>
					{/each}
				</fieldset>
			{:else if wizard.pageId === 'chat-display'}
				<fieldset>
					<legend class="mb-2 text-sm font-medium text-foreground">
						{m.settings_chat_max_width()}
					</legend>
					<div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
						{#each chatMaxWidthOptions as option (option.value)}
							<label class={cn(optionCardClass, 'gap-1.5 p-2')}>
								<input
									type="radio"
									class="sr-only"
									name="onboarding-chat-max-width"
									value={option.value}
									checked={ls.chatMaxWidth === option.value}
									onchange={() => wizard.selectChatMaxWidth(option.value)}
								/>
								<span
									class="flex h-8 w-full items-center justify-center rounded-md bg-muted/60 px-1"
									aria-hidden="true"
								>
									<span class={cn('h-3 rounded-xs bg-muted-foreground/50', option.previewClass)}
									></span>
								</span>
								<span class="text-xs font-medium text-foreground">{option.label()}</span>
							</label>
						{/each}
					</div>
				</fieldset>
				<div class="mt-3 rounded-lg border border-border bg-muted/50 px-4">
					<div class="flex items-center justify-between gap-4 py-2">
						<span class="text-sm font-medium text-foreground">
							{m.settings_chat_show_thinking()}
						</span>
						<Switch
							checked={ls.showThinking}
							onCheckedChange={() => wizard.toggleShowThinking()}
							aria-label={m.settings_chat_show_thinking()}
						/>
					</div>
					<div class="flex items-center justify-between gap-4 py-2">
						<span class="text-sm font-medium text-foreground">
							{m.settings_chat_auto_expand_tools()}
						</span>
						<Switch
							checked={ls.autoExpandTools}
							onCheckedChange={() => wizard.toggleAutoExpandTools()}
							aria-label={m.settings_chat_auto_expand_tools()}
						/>
					</div>
				</div>
			{:else}
				<div class="flex flex-col items-center gap-3 py-6 text-center">
					<span
						class="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary"
					>
						<CheckIcon class="size-6" />
					</span>
				</div>
			{/if}
		</div>

		<Dialog.Footer class="flex-row items-center justify-between gap-2 sm:justify-between">
			<div class="flex items-center gap-2">
				<Button variant="ghost" onclick={() => wizard.back()} disabled={wizard.isFirstPage}>
					{m.onboarding_back()}
				</Button>
			</div>
			<div class="flex flex-wrap items-center justify-end gap-3">
				<div class="flex items-center gap-1.5" aria-hidden="true">
					{#each { length: wizard.pageCount } as _, index (index)}
						<span
							class={cn(
								'size-1.5 rounded-full transition-colors',
								index === wizard.pageIndex ? 'bg-primary' : 'bg-muted-foreground/30',
							)}
						></span>
					{/each}
				</div>
				<span class="sr-only" aria-live="polite" aria-atomic="true">
					{m.onboarding_step_label({ current: wizard.pageIndex + 1, total: wizard.pageCount })}
				</span>
				{#if wizard.isDonePage}
					<Button variant="outline" onclick={() => wizard.finishToProviders()}>
						{m.onboarding_done_providers()}
					</Button>
					<Button onclick={() => wizard.finish()}>{m.onboarding_done_start()}</Button>
				{:else}
					<Button onclick={() => wizard.advance()}>{m.onboarding_continue()}</Button>
				{/if}
			</div>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
