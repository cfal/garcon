import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RemoteProviderAuxiliaryService } from '../../../server/execution-nodes/remote-provider-auxiliary.js';
import { createNodeSessionFixture, nodeSessionSystemdAvailable } from '../../support/node-session-handshake-fixture.js';
import { TlsCertificates } from '../../support/tls-certificates.js';
import { claudeText, claudeToolUse } from '../../support/fake-claude-model.js';
import { startScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';
import { withTimeout } from '../../support/deferred.js';

test.skipIf(!nodeSessionSystemdAvailable)('a successful Claude one-shot drains an MCP process whose event loop outlives stdin EOF', async () => {
  const environment = await startScriptedClaudeTestEnvironment();
  environment.model.scriptTurn([claudeToolUse('toolu_synthetic_mcp', 'mcp__synthetic__echo', {})]);
  const held = environment.model.scriptHeldTurn([claudeText('synthetic MCP answer')]);
  const certificates = await TlsCertificates.create();
  const certificate = await certificates.selfSigned('claude-mcp-lifetime');
  const f = await createNodeSessionFixture(certificate, certificate.trust, {
    instance: { agentId: 'claude', environment: { ...environment.serverEnvironment, ENABLE_TOOL_SEARCH: 'false' } }, maxOperations: 1,
  });
  try {
    const nativeHome = path.join(f.storage, 'native', '.claude');
    const program = path.join(f.storage, 'synthetic-mcp.cjs');
    const pidFile = path.join(f.storage, 'synthetic-mcp.pid');
    await mkdir(nativeHome, { recursive: true, mode: 0o700 });
    await writeFile(path.join(nativeHome, 'settings.json'), JSON.stringify({
      enableAllProjectMcpServers: true, permissions: { allow: ['mcp__synthetic__echo'] },
    }), { mode: 0o600 });
    await writeFile(program, `const fs = require('node:fs');
const readline = require('node:readline');
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === 'initialize'
    ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'synthetic', version: '1' } }
    : request.method === 'tools/list'
      ? { tools: [{ name: 'echo', description: 'Returns synthetic text', inputSchema: { type: 'object', properties: {} } }] }
      : request.method === 'tools/call' ? { content: [{ type: 'text', text: 'synthetic MCP result' }] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`, { mode: 0o600 });
    await writeFile(path.join(f.storage, '.mcp.json'), JSON.stringify({
      mcpServers: { synthetic: { type: 'stdio', command: process.execPath, args: [program] } },
    }), { mode: 0o600 });

    const connection = await f.connect().ready;
    const controller = await f.controller(connection);
    const recovery = await controller.client.service.call({ method: 'begin-output-recovery' }, controller.signal);
    if (recovery.kind !== 'output-recovery') throw new Error('Synthetic recovery did not begin');
    await controller.client.service.call({ method: 'replay-output', generation: recovery.generation, cursors: [] }, controller.signal);
    expect(await controller.client.service.call({ method: 'resume-output', generation: recovery.generation }, controller.signal))
      .toEqual({ kind: 'output-live', live: true });
    const service = new RemoteProviderAuxiliaryService(controller.client.service, 'synthetic-instance', connection.lease.session);
    const running = service.singleQuery('synthetic-workspace', { prompt: 'synthetic MCP input', timeoutMs: 20_000,
      configuration: { model: 'haiku', thinkingMode: 'none', settings: null, endpoint: null } }, controller.signal);
    void running.catch(() => {});
    const request = await withTimeout(held.requested, 15_000, () => 'Synthetic MCP tool did not return');
    expect(request.toolResults).toEqual([expect.objectContaining({ toolUseId: 'toolu_synthetic_mcp', content: 'synthetic MCP result' })]);
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    expect(existsSync(`/proc/${pid}`)).toBe(true);
    const identity = (await f.marker.read())?.identity;
    if (!identity) throw new Error('Synthetic containment identity missing');
    expect(await readFile(`/proc/${pid}/cgroup`, 'utf8')).toContain(identity.controlGroup);
    held.release();
    expect((await running).trim()).toBe('synthetic MCP answer');
    expect(existsSync(`/proc/${pid}`)).toBe(false);
    expect(f.containmentRequests).toEqual([]);
    environment.model.assertSettled();
  } finally {
    held.release();
    await f.dispose();
    await certificates.dispose();
    environment.dispose();
  }
}, 35_000);
