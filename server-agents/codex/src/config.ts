import os from 'node:os';
import path from 'node:path';
import type { AgentHost } from '@garcon/server-agent-interface';
import { AgentHostEnvironment } from '@garcon/server-agent-common/legacy/host-environment';

const environment = new AgentHostEnvironment();

export function bindAgentHost(host: AgentHost): void { environment.bind(host); }
export function getClaudeBinary(): string { return environment.valueOr('CLAUDE_BINARY', 'claude'); }
export function getCursorBinary(): string { return environment.valueOr('CURSOR_BINARY', 'cursor-agent'); }
export function getOpenAiApiKey(): string | null { return environment.value('OPENAI_API_KEY'); }
export function getOpenAiBaseUrl(): string | null { return environment.value('OPENAI_BASE_URL'); }
export function getCodexHome(): string { return environment.value('CODEX_HOME') ?? path.join(os.homedir(), '.codex'); }
export function getPackageVersion(): string { return environment.valueOr('npm_package_version', '0.1.0'); }
