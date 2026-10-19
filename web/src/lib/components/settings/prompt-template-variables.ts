// Template tokens a prompt editor offers to insert, and the help that explains them.

import { RUNTIME_TEMPLATE_VARIABLES } from '$shared/template-tokens';
import { SCHEDULED_PROMPT_CHAT_ID_TOKEN } from '$shared/scheduled-prompts';
import * as m from '$lib/paraglide/messages.js';

export interface PromptTemplateVariables {
	tokens: readonly string[];
	help: string;
}

export function scheduledPromptVariables(
	targetType: 'new-chat' | 'existing-chat',
): PromptTemplateVariables {
	const token = SCHEDULED_PROMPT_CHAT_ID_TOKEN;
	return {
		tokens: RUNTIME_TEMPLATE_VARIABLES.map((variable) => `{{${variable}}}`),
		help:
			targetType === 'new-chat'
				? m.scheduled_prompts_new_chat_id_help({ token })
				: m.scheduled_prompts_existing_chat_id_help({ token }),
	};
}
