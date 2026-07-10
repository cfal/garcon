import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleChatPrompt } from '../scheduled-tasks';

vi.stubGlobal('localStorage', {
	getItem: () => 'test-token',
	setItem: () => {},
	removeItem: () => {},
});

const task = {
	id: 'task-in',
	schedule: { type: 'once' as const, nextRunAt: '2030-01-01T09:00:00.000Z' },
	target: {
		type: 'existing-chat' as const,
		chatId: '123',
		busyBehavior: 'skip' as const,
	},
	prompt: 'Continue the work',
	createdAt: '2029-01-01T00:00:00.000Z',
	updatedAt: '2029-01-01T00:00:00.000Z',
};

describe('scheduled tasks API contract', () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('posts a relative task and normalizes the created task and snapshot', async () => {
		fetchMock.mockResolvedValue(
			Response.json({
				success: true,
				task,
				snapshot: { revision: 1, tasks: [task], runLog: [] },
			}),
		);

		const result = await scheduleChatPrompt({
			chatId: '123',
			duration: '2h30m',
			prompt: 'Continue the work',
		});

		expect(result.task).toMatchObject(task);
		const [url, options] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/scheduled-tasks/in');
		expect(options.method).toBe('POST');
		expect(options.headers.Authorization).toBe('Bearer test-token');
		expect(JSON.parse(options.body)).toEqual({
			chatId: '123',
			duration: '2h30m',
			prompt: 'Continue the work',
		});
	});

	it('rejects malformed responses and snapshots that omit the task', async () => {
		fetchMock.mockResolvedValueOnce(
			Response.json({
				success: true,
				task: { ...task, schedule: { type: 'once', nextRunAt: 'invalid' } },
				snapshot: { revision: 1, tasks: [task], runLog: [] },
			}),
		);
		await expect(
			scheduleChatPrompt({ chatId: '123', duration: '1m', prompt: 'Continue' }),
		).rejects.toThrow('Invalid schedule-in response');

		fetchMock.mockResolvedValueOnce(
			Response.json({
				success: true,
				task,
				snapshot: { revision: 1, tasks: [], runLog: [] },
			}),
		);
		await expect(
			scheduleChatPrompt({ chatId: '123', duration: '1m', prompt: 'Continue' }),
		).rejects.toThrow('omitted the created task');
	});

	it('preserves typed API errors', async () => {
		fetchMock.mockResolvedValue(
			Response.json(
				{
					success: false,
					error: 'Seconds are not supported',
					errorCode: 'SCHEDULE_IN_SUB_MINUTE_UNSUPPORTED',
					retryable: false,
				},
				{ status: 400 },
			),
		);

		await expect(
			scheduleChatPrompt({ chatId: '123', duration: '10s', prompt: 'Continue' }),
		).rejects.toMatchObject({
			status: 400,
			errorCode: 'SCHEDULE_IN_SUB_MINUTE_UNSUPPORTED',
			retryable: false,
		});
	});
});
