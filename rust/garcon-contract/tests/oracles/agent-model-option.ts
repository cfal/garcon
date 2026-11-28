import { modelsFromProviders } from '../../../../server-agents/opencode/src/agents/opencode/model-catalog.ts';

// The first argument is the wire model read by the Rust decoder. The original
// has no model-option parser on the route, so its result comes from the producer.
export function writeOpenCodeModelOptions(_wire: unknown, providers: unknown[]) {
  return modelsFromProviders(providers);
}
