import {
  createAgentResourceRef, type AgentInstanceCallOptions, type AgentResourceScope,
} from '../../../server-agents/interface/src/contracts/resources.ts';
import type { FileRpcMethods } from '../../../server/remote/transport/file-protocol.ts';
import type { TerminalRpcMethods } from '../../../server/remote/transport/terminal-protocol.ts';

const scope: AgentResourceScope = { executorId: 'local', instanceId: 'fixture-instance', integrationId: 'claude' };
const options: AgentInstanceCallOptions = { expectedScope: scope };
const id = '11111111-1111-4111-8111-111111111111';
const reference = <K extends string>(kind: K) => ({ ...createAgentResourceRef(scope, kind), id });
const target: FileRpcMethods['files.identity']['request'] = { projectPath: '/work/app', filePath: 'README.md' };
const browse: FileRpcMethods['files.browse']['request'] = { directoryPath: '/work/app' };
const tree: FileRpcMethods['files.tree']['request'] = {};
const list: FileRpcMethods['files.list']['request'] = { projectPath: '/work/app' };
const files: FileRpcMethods['files.list']['result'] = {
  files: [
    { name: 'README.md', path: '/work/app/README.md', relativePath: 'README.md', type: 'file' },
    { name: 'src', path: '/work/app/src', type: 'directory' },
  ],
  truncated: false,
};
const createDirectory: FileRpcMethods['files.createDirectory']['request'] = { parentPath: '/work/app', name: 'docs' };
const terminalList: TerminalRpcMethods['terminals.list']['request'] = { authority: { key: 'fixture-authority', expiresAtMs: null } };
const terminalAttach: TerminalRpcMethods['terminals.attach']['request'] = {
  type: 'terminal-attach', terminalId: 'fixture-terminal', clientId: 'fixture-client', afterSequence: 1e21,
  intent: 'restore', attachmentEpoch: 'fixture-epoch', attachmentId: 'fixture-attachment',
  authority: { key: 'fixture-authority', expiresAtMs: 1_800_000_000_000 },
};
const { authority, ...attach } = terminalAttach;
const fileIdentity: FileRpcMethods['files.identity']['result'] = {
  executorId: 'local', canonicalFileRootPath: '/work/app', normalizedRelativePath: 'README.md',
};
const fileTree: FileRpcMethods['files.tree']['result'] = {
  fileRootPath: '/work/app', homeDirectory: null,
  directory: { path: '/work/app', relativePath: '', parentPath: null, breadcrumbs: [{ name: 'app', path: '/work/app' }] },
  entries: [{ name: 'README.md', path: '/work/app/README.md', relativePath: 'README.md', type: 'file',
    size: 42, modified: '2026-01-01T00:00:00.000Z', permissionsRwx: 'rw-r--r--' }],
};
const fileRevision: FileRpcMethods['files.revision']['result'] = { status: 'ready', revision: 'v1:fixture' };
const missingRevision: FileRpcMethods['files.revision']['result'] = { status: 'missing' };
const fileSaved: FileRpcMethods['files.save']['result'] = {
  success: true, path: '/work/app/README.md', message: 'Saved', revision: 'v1:new_fixture',
};
const directoryCreated: FileRpcMethods['files.createDirectory']['result'] = {
  name: 'docs', path: '/work/app/docs', type: 'directory',
};
const terminalCreated: TerminalRpcMethods['terminals.create']['result'] = {
  success: true,
  terminal: { terminalId: 'fixture-terminal', displaySequence: 1, title: 'Fixture shell', initialWorkingDirectory: '/work/app',
    processStatus: 'running', attachmentStatus: 'detached', createdAt: '2026-01-01T00:00:00.000Z', exitCode: null, latestOutputSequence: 0 },
};
const terminals: TerminalRpcMethods['terminals.list']['result'] = {
  success: true, terminals: [terminalCreated.terminal], terminalRuntimeId: 'fixture-runtime', attachmentEpoch: 'fixture-epoch',
};
const terminalRenamed: TerminalRpcMethods['terminals.rename']['result'] = { success: true, terminalId: 'fixture-terminal', title: null };
const terminalTerminated: TerminalRpcMethods['terminals.terminate']['result'] = { success: true, terminalId: 'fixture-terminal', terminal: null };

for (const value of [scope, options, reference('producer'), reference('permission-response'), reference('project-path-preparation'),
  target, browse, tree, list, files, createDirectory, terminalList.authority, authority, attach,
  fileIdentity, fileTree, fileRevision, missingRevision, fileSaved, directoryCreated, terminalCreated, terminals,
  terminalRenamed, terminalTerminated]) {
  console.log(JSON.stringify(value));
}
