import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScheduledPrompt, getScheduledPrompts, updateScheduledPrompt, scheduleChatPrompt, setScheduledPromptEnabled } from '../scheduled-prompts';
import {
	SCHEDULED_PROMPT_LABEL_MAX_LENGTH,
	normalizeScheduledPromptTarget,
	normalizeScheduledPromptsSnapshot,
} from '$shared/scheduled-prompts';

vi.stubGlobal('localStorage', {
	getItem: (key: string) =>
		key === 'bearer-token' ? JSON.stringify({ token: 'test-token', epoch: null }) : null,
	setItem: () => {},
	removeItem: () => {},
});

const scheduledPrompt = {
	id: 'prompt-in',
	enabled: true,
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

describe('scheduled prompts API contract', () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('sends typed enablement and normalizes the persisted state', async () => {
		const paused = { ...scheduledPrompt, enabled: false };
		fetchMock.mockResolvedValue(Response.json({ success: true, snapshot: { revision: 2, prompts: [paused], runLog: [] } }));
		const result = await setScheduledPromptEnabled({ expectedRevision: 1, id: paused.id, enabled: false });
		expect(result.snapshot.prompts[0].enabled).toBe(false);
		const [url, options] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/scheduled-prompts/enabled');
		expect(options.method).toBe('PUT');
		expect(JSON.parse(options.body)).toEqual({ expectedRevision: 1, id: paused.id, enabled: false });
	});

	it('posts a relative scheduled prompt and normalizes the created prompt and snapshot', async () => {
		fetchMock.mockResolvedValue(
			Response.json({
				success: true,
				scheduledPrompt,
				snapshot: { revision: 1, prompts: [scheduledPrompt], runLog: [] },
			}),
		);

		const result = await scheduleChatPrompt({
			chatId: '123',
			duration: '2h30m',
			prompt: 'Continue the work',
		});

		expect(result.scheduledPrompt).toMatchObject(scheduledPrompt);
		const [url, options] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/scheduled-prompts/in');
		expect(options.method).toBe('POST');
		expect(new Headers(options.headers).get('Authorization')).toBe('Bearer test-token');
		expect(JSON.parse(options.body)).toEqual({
			chatId: '123',
			duration: '2h30m',
			prompt: 'Continue the work',
		});
	});

	it('retains task names and custom titles in both mutation and GET responses', async () => {
		const target = {
			type: 'new-chat' as const, agentId: 'codex', projectPath: '/workspace/project', model: 'gpt-5',
			apiProviderId: null, modelEndpointId: null, modelProtocol: null,
			permissionMode: 'default' as const, thinkingMode: 'none' as const, agentSettingsById: {}, tags: [],
			preambleChoice: { mode: 'defaults' as const }, chatTitleTemplate: 'Review {{current_date}}',
		};
		const prompt = { ...scheduledPrompt, name: 'Daily review', target };
		const snapshot = { revision: 1, prompts: [prompt], runLog: [] };
		fetchMock.mockImplementation(async (_url, options) => Response.json(
			(options.method ?? 'GET') === 'GET' ? snapshot : { success: true, snapshot },
		));
		const request = { expectedRevision: 0, scheduledPrompt: {
			schedule: { type: 'once' as const, runAtUtc: prompt.schedule.nextRunAt },
			name: prompt.name, target, prompt: prompt.prompt,
		} };
		expect((await createScheduledPrompt(request)).snapshot).toEqual(snapshot);
		expect(await getScheduledPrompts()).toEqual(snapshot);
		expect((await updateScheduledPrompt({ ...request, id: prompt.id })).snapshot).toEqual(snapshot);
		expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(request);
	});

	it('rejects malformed responses and snapshots that omit the scheduled prompt', async () => {
		fetchMock.mockResolvedValueOnce(
			Response.json({
				success: true,
				scheduledPrompt: { ...scheduledPrompt, schedule: { type: 'once', nextRunAt: 'invalid' } },
				snapshot: { revision: 1, prompts: [scheduledPrompt], runLog: [] },
			}),
		);
		await expect(
			scheduleChatPrompt({ chatId: '123', duration: '1m', prompt: 'Continue' }),
		).rejects.toThrow('Invalid schedule-in response');

		fetchMock.mockResolvedValueOnce(
			Response.json({
				success: true,
				scheduledPrompt,
				snapshot: { revision: 1, prompts: [], runLog: [] },
			}),
		);
		await expect(
			scheduleChatPrompt({ chatId: '123', duration: '1m', prompt: 'Continue' }),
		).rejects.toThrow('omitted the created prompt');
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

describe('scheduled new-chat target normalization', () => {
	const target = {
		type: 'new-chat',
		agentId: 'codex',
		projectPath: '/workspace/project',
		model: 'gpt-5',
		apiProviderId: null,
		modelEndpointId: null,
		modelProtocol: null,
		permissionMode: 'acceptEdits',
		thinkingMode: 'high',
		agentSettingsById: {
			codex: { ownerId: 'codex', schemaVersion: 1, values: {} },
		},
		preambleChoice: { mode: 'defaults' },
	};

	it('normalizes tags and preserves the required preamble choice', () => {
		expect(normalizeScheduledPromptTarget(target)).toMatchObject({ tags: [] });
		expect(
			normalizeScheduledPromptTarget({
				...target,
				tags: ['Review Needed', 'review-needed', ' QA ', 42, '!!!'],
			}),
		).toMatchObject({ tags: ['qa', 'review-needed'] });
	});

	it('rejects a non-array tags field', () => {
		expect(normalizeScheduledPromptTarget({ ...target, tags: 'review' })).toBeNull();
	});
});

describe('scheduled prompt run log normalization', () => {
	const entry = {
		at: '2030-01-01T09:00:00.000Z',
		scheduledPromptId: 'prompt-in',
		promptLabel: 'Continue the work',
		outcome: 'created-chat',
		chatId: '123',
		message: 'Prompt executed successfully; created chat 123.',
	};

	it('keeps typed entries and drops malformed or legacy string entries', () => {
		const schedulerEntry = {
			...entry,
			scheduledPromptId: null,
			promptLabel: null,
			chatId: null,
			outcome: 'failed',
		};
		const snapshot = normalizeScheduledPromptsSnapshot({
			revision: 1,
			prompts: [scheduledPrompt],
			runLog: [
				entry,
				schedulerEntry,
				{ ...entry, promptLabel: '' },
				'[2030-01-01T09:00:00.000Z] Prompt sent to chat 123.',
				{ ...entry, outcome: 'unknown' },
				{ ...entry, at: 'invalid' },
				{ ...entry, chatId: 42 },
				{ ...entry, promptLabel: null },
				{ ...entry, promptLabel: undefined },
				{ ...entry, promptLabel: 'x'.repeat(SCHEDULED_PROMPT_LABEL_MAX_LENGTH + 1) },
				{ ...schedulerEntry, promptLabel: 'Continue the work' },
			],
		});

		expect(snapshot?.runLog).toEqual([entry, schedulerEntry, { ...entry, promptLabel: '' }]);
	});
});
