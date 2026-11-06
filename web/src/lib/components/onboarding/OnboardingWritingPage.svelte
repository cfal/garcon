<script lang="ts">
	import TextCursorInputIcon from '@lucide/svelte/icons/text-cursor-input';
	import CodeIcon from '@lucide/svelte/icons/code';
	import { getLocalSettings } from '$lib/context';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import * as m from '$lib/paraglide/messages.js';
	import { ONBOARDING_OPTION_CARD_CLASS } from './onboarding-option-card.js';

	const ls = getLocalSettings();
</script>

<fieldset>
	<legend class="mb-3 text-sm font-medium">{m.chat_composer_input_mode()}</legend>
	<div class="grid grid-cols-2 gap-3">
		<label class={ONBOARDING_OPTION_CARD_CLASS}>
			<input
				type="radio"
				class="sr-only"
				name="onboarding-input-mode"
				value="formatted"
				checked={ls.composerInputMode === 'formatted'}
				onchange={() => ls.set('composerInputMode', 'formatted')}
			/>
			<TextCursorInputIcon class="size-6 text-muted-foreground" />
			<span class="text-sm font-medium">{m.chat_composer_formatted_mode()}</span>
		</label>
		<label class={ONBOARDING_OPTION_CARD_CLASS}>
			<input
				type="radio"
				class="sr-only"
				name="onboarding-input-mode"
				value="source"
				checked={ls.composerInputMode === 'source'}
				onchange={() => ls.set('composerInputMode', 'source')}
			/>
			<CodeIcon class="size-6 text-muted-foreground" />
			<span class="text-sm font-medium">{m.chat_composer_source_mode()}</span>
		</label>
	</div>
</fieldset>

<div class="mt-5 divide-y divide-border">
	<div class="flex items-center justify-between gap-4 py-3">
		<span class="text-sm font-medium">{m.settings_chat_send_by_shift_enter()}</span>
		<Switch
			checked={ls.sendByShiftEnter}
			onCheckedChange={(checked) => ls.set('sendByShiftEnter', checked)}
			aria-label={m.settings_chat_send_by_shift_enter()}
		/>
	</div>
	<div class="flex items-center justify-between gap-4 py-3">
		<span class="text-sm font-medium">{m.settings_chat_auto_scroll_to_bottom()}</span>
		<Switch
			checked={ls.autoScrollToBottom}
			onCheckedChange={(checked) => ls.set('autoScrollToBottom', checked)}
			aria-label={m.settings_chat_auto_scroll_to_bottom()}
		/>
	</div>
	<div class="flex items-center justify-between gap-4 py-3">
		<span class="text-sm font-medium">{m.settings_chat_reduce_motion()}</span>
		<Switch
			checked={ls.reduceMotion}
			onCheckedChange={(checked) => ls.set('reduceMotion', checked)}
			aria-label={m.settings_chat_reduce_motion()}
		/>
	</div>
</div>
