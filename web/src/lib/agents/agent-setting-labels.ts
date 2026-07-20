import type {
	AgentOption,
	AgentSettingDescriptor,
	AgentSettingLabelKey,
	AgentSettingOptionDescriptionKey,
	AgentSettingOptionLabelKey,
} from '$shared/agent-integration';
import * as m from '$lib/paraglide/messages.js';

const SETTING_LABELS = {
	thinking: m.chat_composer_agent_setting_thinking,
	mode: m.chat_composer_agent_setting_mode,
} satisfies Record<AgentSettingLabelKey, () => string>;

const OPTION_LABELS = {
	automatic: m.chat_composer_agent_setting_automatic,
	enabled: m.chat_composer_agent_setting_enabled,
	disabled: m.chat_composer_agent_setting_disabled,
	smart: m.chat_composer_agent_setting_smart,
	deep: m.chat_composer_agent_setting_deep,
} satisfies Record<AgentSettingOptionLabelKey, () => string>;

const OPTION_DESCRIPTIONS = {
	thinkingAutomatic: m.chat_composer_agent_setting_thinking_automatic_description,
	thinkingEnabled: m.chat_composer_agent_setting_thinking_enabled_description,
	thinkingDisabled: m.chat_composer_agent_setting_thinking_disabled_description,
} satisfies Record<AgentSettingOptionDescriptionKey, () => string>;

export function agentSettingLabel(descriptor: AgentSettingDescriptor): string {
	return descriptor.labelKey ? SETTING_LABELS[descriptor.labelKey]() : descriptor.label;
}

export function agentSettingOptionLabel(option: AgentOption): string {
	return option.labelKey ? OPTION_LABELS[option.labelKey]() : option.label;
}

export function agentSettingOptionDescription(option: AgentOption): string | null {
	if (option.descriptionKey) return OPTION_DESCRIPTIONS[option.descriptionKey]();
	return option.description ?? null;
}
