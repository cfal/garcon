import type { InterAgentMessageFailureReason } from '$shared/transcript-notice-details';
import * as m from '$lib/paraglide/messages.js';

export function interAgentMessageFailureLabel(reason: InterAgentMessageFailureReason): string {
	switch (reason) {
		case 'disabled':
			return m.chat_message_inter_agent_failure_disabled();
		case 'self-send':
			return m.chat_message_inter_agent_failure_self_send();
		case 'target-not-found':
			return m.chat_message_inter_agent_failure_target_not_found();
		case 'target-unavailable':
			return m.chat_message_inter_agent_failure_target_unavailable();
		case 'queue-full':
			return m.chat_message_inter_agent_failure_queue_full();
		case 'provider-rejected':
			return m.chat_message_inter_agent_failure_provider_rejected();
		case 'delivery-unknown':
			return m.chat_message_inter_agent_failure_delivery_unknown();
		case 'server-shutting-down':
			return m.chat_message_inter_agent_failure_server_shutting_down();
		case 'delivery-failed':
			return m.chat_message_inter_agent_failure_delivery_failed();
	}
}
