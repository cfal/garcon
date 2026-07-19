import type { AgentHost } from '@garcon/server-agent-interface';
import { AgentHostEnvironment } from '@garcon/server-agent-common/legacy/host-environment';

const environment = new AgentHostEnvironment();

export function bindAgentHost(host: AgentHost): void { environment.bind(host); }
export function getClaudeBinary(): string { return environment.valueOr('CLAUDE_BINARY', 'claude'); }
export function getCursorBinary(): string { return environment.valueOr('CURSOR_BINARY', 'cursor-agent'); }
export function getAnthropicApiKey(): string | null { return environment.value('ANTHROPIC_API_KEY'); }
export function getAnthropicBaseUrl(): string | null { return environment.value('ANTHROPIC_BASE_URL'); }
