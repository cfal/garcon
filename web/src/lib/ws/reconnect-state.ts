import type { ReconnectStateMessage } from '$shared/ws-events';

export function extractRunningChatIds(msg: ReconnectStateMessage): Set<string> {
	const groupedSessions: unknown[] =
		msg.sessions && typeof msg.sessions === 'object' ? Object.values(msg.sessions) : [];
	return new Set(
		groupedSessions
			.filter((sessions): sessions is Array<{ id?: string }> => Array.isArray(sessions))
			.flatMap((sessions) => sessions)
			.map((session) => session?.id)
			.filter((id): id is string => Boolean(id)),
	);
}
