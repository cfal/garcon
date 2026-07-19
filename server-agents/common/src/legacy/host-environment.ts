import type { AgentHost } from '@garcon/server-agent-interface';

export class AgentHostEnvironment {
  #host: AgentHost | null = null;

  bind(host: AgentHost): void {
    if (this.#host && this.#host !== host) throw new Error('Agent host is already bound');
    this.#host = host;
  }

  value(name: string): string | null {
    const value = this.#host?.environment.get(name) ?? process.env[name];
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  }

  valueOr(name: string, fallback: string): string {
    return this.value(name) ?? fallback;
  }
}
