<script lang="ts">
	import TextCursorInputIcon from '@lucide/svelte/icons/text-cursor-input';
	import CodeIcon from '@lucide/svelte/icons/code';
	import { getLocalSettings } from '$lib/context';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import * as m from '$lib/paraglide/messages.js';
	import { ONBOARDING_OPTION_CARD_CLASS } from './onboarding-option-card.js';

	const ls = getLocalSettings();
	const inputModes = [
		{ value: 'formatted', label: m.chat_composer_formatted_mode, icon: TextCursorInputIcon },
		{ value: 'source', label: m.chat_composer_source_mode, icon: CodeIcon },
	] as const;
	const behaviorOptions = [
		{ key: 'sendByShiftEnter', label: m.settings_chat_send_by_shift_enter },
		{ key: 'autoScrollToBottom', label: m.settings_chat_auto_scroll_to_bottom },
		{ key: 'reduceMotion', label: m.settings_chat_reduce_motion },
	] as const;
</script>

<fieldset>
	<legend class="mb-3 text-sm font-medium">{m.chat_composer_input_mode()}</legend>
	<div class="grid grid-cols-2 gap-3">
		{#each inputModes as option (option.value)}
			<label class={ONBOARDING_OPTION_CARD_CLASS}>
				<input
					type="radio"
					class="sr-only"
					name="onboarding-input-mode"
					value={option.value}
					checked={ls.composerInputMode === option.value}
					onchange={() => ls.set('composerInputMode', option.value)}
				/>
				<option.icon class="size-6 text-muted-foreground" />
				<span class="text-sm font-medium">{option.label()}</span>
			</label>
		{/each}
	</div>
</fieldset>

<div class="mt-5 divide-y divide-border">
	{#each behaviorOptions as option (option.key)}
		<div class="flex items-center justify-between gap-4 py-3">
			<span class="text-sm font-medium">{option.label()}</span>
			<Switch
				checked={ls[option.key]}
				onCheckedChange={(checked) => ls.set(option.key, checked)}
				aria-label={option.label()}
			/>
		</div>
	{/each}
</div>
