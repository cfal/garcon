import { expect, spyOn, test } from 'bun:test';
import { waitForTranscriptResult } from '../smoke-exe.js';

test('compiled search smoke continues after one request timeout within its existing deadline', async () => {
  const fetchSpy = spyOn(globalThis, 'fetch')
    .mockRejectedValueOnce(new DOMException('synthetic slow response', 'TimeoutError'))
    .mockResolvedValueOnce(Response.json({ results: [{ chatId: 'synthetic-chat' }] }));
  try {
    await waitForTranscriptResult('http://synthetic.invalid', 'synthetic-token', 'synthetic-chat',
      () => 'synthetic server output', { Authorization: 'Bearer synthetic-credential' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    for (const [url, request] of fetchSpy.mock.calls) {
      expect(url).toBe('http://synthetic.invalid/api/v1/chats/search');
      expect(request.headers.Authorization).toBe('Bearer synthetic-credential');
      expect(request.body).toBe(JSON.stringify({ query: 'synthetic-token' }));
      expect(request.signal).toBeInstanceOf(AbortSignal);
    }
  } finally { fetchSpy.mockRestore(); }
});

test('compiled search smoke retains timeout and server diagnostics when its deadline expires', async () => {
  const fetchSpy = spyOn(globalThis, 'fetch')
    .mockRejectedValueOnce(new DOMException('synthetic slow response', 'TimeoutError'));
  const now = spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(45_001);
  try {
    const failure = await waitForTranscriptResult('http://synthetic.invalid', 'synthetic-token', 'synthetic-chat',
      () => 'synthetic server output', {}).catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain('last status was 0');
    expect(failure.message).toContain('TimeoutError: synthetic slow response');
    expect(failure.message).toContain('Captured output:\nsynthetic server output');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  } finally { fetchSpy.mockRestore(); now.mockRestore(); }
});
