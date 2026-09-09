import type { AgentEmissionSink, AgentProducerSink } from '@garcon/server-agent-interface';

export function localEmissionSink(sink: AgentProducerSink): AgentEmissionSink {
  return Object.freeze({ emit: (event) => sink.publish(event) } satisfies AgentEmissionSink);
}
