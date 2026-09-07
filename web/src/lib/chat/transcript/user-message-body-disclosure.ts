import type { UserMessagePresentation } from '$shared/chat-types';

export function userMessageBodyDisclosure(
	presentation: UserMessagePresentation | null | undefined,
): 'collapsed' | undefined {
	return presentation ? presentation.disclosure : 'collapsed';
}
