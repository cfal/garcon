import { parseChatId } from '../../common/chat-id.js';

export interface NotificationWindow {
	readonly url: string;
	readonly focused: boolean;
	navigate(url: string): Promise<{ focus(): Promise<unknown> } | null>;
}

export async function openNotificationChat(
	chatId: unknown,
	origin: string,
	windows: readonly NotificationWindow[],
	openWindow: (url: string) => Promise<unknown>,
): Promise<void> {
	let id: string;
	try {
		id = parseChatId(chatId);
	} catch {
		return;
	}
	const url = `${origin}/chat/${id}`;
	const appWindows = windows.filter((client) => {
		const current = new URL(client.url);
		return (
			current.origin === origin &&
			(current.pathname === '/' || current.pathname.startsWith('/chat/'))
		);
	});
	const client = appWindows.find((client) => client.focused) ?? appWindows[0];
	if (client) {
		const navigated = await client.navigate(url).catch(() => null);
		if (navigated) {
			await navigated.focus();
			return;
		}
	}
	await openWindow(url);
}
