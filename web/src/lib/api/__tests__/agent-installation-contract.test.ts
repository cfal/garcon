import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentInstallationStatus, updateAgentInstallation } from '../agent-installation';
import { ApiError } from '../client';

describe('agent installation API contract', () => {
	const fetchMock = vi.fn();
	beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
	afterEach(() => vi.unstubAllGlobals());

	it('qualifies and encodes the installation status query', async () => {
		const status = { version: '2.1.207', minimumVersion: '2.1.238', supported: false };
		fetchMock.mockResolvedValue(Response.json(status));
		await expect(getAgentInstallationStatus('claude/custom', 'executor a')).resolves.toEqual(status);
		expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/agents/installation?agent=claude%2Fcustom&executorId=executor%20a');
	});

	it('posts the explicit selected executor and allows the bounded updater to finish', async () => {
		const result = { installation: { version: '2.1.285', minimumVersion: '2.1.238', supported: true }, output: 'Update complete' };
		const timeout = vi.spyOn(AbortSignal, 'timeout');
		fetchMock.mockResolvedValue(Response.json(result));
		await expect(updateAgentInstallation({ agentId: 'claude', executorId: 'remote-executor', instanceId: 'instance-a' })).resolves.toEqual(result);
		expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/agents/installation/update');
		expect(fetchMock.mock.calls[0][1].method).toBe('POST');
		expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ agentId: 'claude', executorId: 'remote-executor', instanceId: 'instance-a' });
		expect(timeout).toHaveBeenCalledWith(135_000);
		timeout.mockRestore();
	});

	it('preserves structured update failures for inline feedback', async () => {
		fetchMock.mockResolvedValue(Response.json({ success: false, error: 'Permission denied', errorCode: 'PROVIDER_FAILURE', retryable: true }, { status: 503 }));
		await expect(updateAgentInstallation({ agentId: 'claude', executorId: 'local', instanceId: 'local-instance' })).rejects.toBeInstanceOf(ApiError);
	});
});
