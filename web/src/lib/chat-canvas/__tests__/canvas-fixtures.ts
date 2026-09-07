import type { CanvasContent, ChatCanvas } from '$shared/chat-canvas';
import type { CanvasRecoveryPort } from '../canvas-recovery';

export function canvasContent(): CanvasContent {
	return {
		title: 'Work',
		nodes: [
			{ id: 'box-a', type: 'box', title: 'Research', position: { x: 0, y: 0 } },
			{ id: 'box-b', type: 'box', title: 'Implementation', position: { x: 500, y: 0 } },
			{
				id: 'chat-a',
				type: 'chat',
				chatId: '1780000000000001',
				boxId: 'box-a',
				position: { x: 0, y: 0 },
			},
			{
				id: 'chat-b',
				type: 'chat',
				chatId: '1780000000000002',
				boxId: 'box-a',
				position: { x: 0, y: 0 },
			},
		],
		connections: [
			{
				id: 'edge',
				source: 'box-a',
				target: 'box-b',
				sourceSide: 'right',
				targetSide: 'left',
				label: 'implements',
			},
		],
	};
}

export function canvas(content = canvasContent(), revision = 1): ChatCanvas {
	return { version: 1, id: 'board', revision, updatedAt: '2026-09-07T00:00:00Z', content };
}

export function recoveryMemory() {
	const drafts = new Map<string, ChatCanvas>();
	const port = {
		list: () => [...drafts.values()],
		read: (id: string) => drafts.get(id) ?? null,
		write: (document: ChatCanvas) => {
			drafts.set(document.id, structuredClone(document));
		},
		remove: (id: string) => {
			drafts.delete(id);
		},
	} satisfies CanvasRecoveryPort;
	return { drafts, port };
}

export function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
