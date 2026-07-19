import type { AgentHost } from '@garcon/server-agent-interface';
import { AgentHostEnvironment } from '@garcon/server-agent-common/legacy/host-environment';

const environment = new AgentHostEnvironment();

export function bindAgentHost(host: AgentHost): void { environment.bind(host); }
export function getAmpBinary(): string { return environment.valueOr('AMP_BINARY', 'amp'); }
