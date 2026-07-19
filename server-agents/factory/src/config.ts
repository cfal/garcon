import type { AgentHost } from '@garcon/server-agent-interface';
import { AgentHostEnvironment } from '@garcon/server-agent-common/legacy/host-environment';

const environment = new AgentHostEnvironment();

export function bindAgentHost(host: AgentHost): void { environment.bind(host); }
export function getFactoryBinary(): string { return environment.valueOr('FACTORY_BINARY', 'droid'); }
export function getFactoryApiKey(): string | null { return environment.value('FACTORY_API_KEY'); }
export function resetServerConfigForTests(): void {}
