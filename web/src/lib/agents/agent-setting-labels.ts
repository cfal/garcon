import type {
	AgentOption,
	AgentSettingDescriptor,
	AgentSettingLabelKey,
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

export function agentSettingLabel(descriptor: AgentSettingDescriptor): string {
	return descriptor.labelKey ? SETTING_LABELS[descriptor.labelKey]() : descriptor.label;
}

export function agentSettingOptionLabel(option: AgentOption): string {
	return option.labelKey ? OPTION_LABELS[option.labelKey]() : option.label;
}
