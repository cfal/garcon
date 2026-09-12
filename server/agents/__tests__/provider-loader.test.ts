import { expect, test } from 'bun:test';
import { loadAgentIntegration, loadDefaultAgentIntegrations } from '../default-agent-integrations.js';

test('default composition retains one class array and selected loads preserve class identity', async () => {
  const first = await loadDefaultAgentIntegrations();
  expect(await loadDefaultAgentIntegrations()).toBe(first);
  for (const integration of first) expect(await loadAgentIntegration(integration.integrationId)).toBe(integration);
  await expect(loadAgentIntegration('../synthetic')).rejects.toThrow('Unsupported agent integration');
});

test.each(['codex', 'pi', 'direct-openai-compatible', 'unsupported'])('fresh process imports only the selected provider (%s)', async (agentId) => {
  const modulePath = new URL('../default-agent-integrations.ts', import.meta.url).pathname;
  const source = `
    const { loadAgentIntegration } = await import(${JSON.stringify(modulePath)});
    const providers = () => [...new Set(Object.keys(require.cache)
      .map(file => /\\/server-agents\\/([^/]+)\\/src\\//.exec(file)?.[1])
      .filter(id => id && id !== 'common' && id !== 'interface'))];
    const before = providers();
    let selected = null;
    try { selected = (await loadAgentIntegration(process.argv.at(-1))).integrationId; } catch {}
    console.log(JSON.stringify({ before, selected, after: providers() }));
  `;
  const child = Bun.spawn([process.execPath, '-e', source, '--', agentId], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    const [output, diagnostic, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, diagnostic).toBe(0);
    expect(JSON.parse(output)).toEqual({ before: [], selected: agentId === 'unsupported' ? null : agentId,
      after: agentId === 'unsupported' ? [] : [agentId] });
  } finally { clearTimeout(timeout); }
});

test('native environment discovery imports only package-owned metadata before preparing a process', async () => {
  const modulePath = new URL('../default-agent-integrations.ts', import.meta.url).pathname;
  const source = `
    const { loadAgentNativeEnvironment } = await import(${JSON.stringify(modulePath)});
    const definition = await loadAgentNativeEnvironment('pi');
    const files = Object.keys(require.cache).filter(file => /\\/server-agents\\/pi\\/src\\//.test(file));
    console.log(JSON.stringify({ definition, files: files.map(file => file.split('/').at(-1)) }));
  `;
  const child = Bun.spawn([process.execPath, '-e', source], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    const [output, diagnostic, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, diagnostic).toBe(0);
    expect(JSON.parse(output)).toEqual({ definition: { integrationId: 'pi', directories: [
      { path: '.pi/agent', environmentKey: 'PI_CODING_AGENT_DIR' },
      { path: '.pi/agent/sessions', environmentKey: 'PI_CODING_AGENT_SESSION_DIR' },
    ] }, files: ['native-environment.ts'] });
  } finally { clearTimeout(timeout); }
});
