import DirectOpenAiCompatibleIntegration from '../../server-agents/direct-openai-compatible/src/index.js';
import { AgentIntegrationError, type AgentHost } from '../../server-agents/interface/src/index.js';
import { defaultAgentIntegrations } from '../../server/agents/default-agent-integrations.js';

const validationGate = process.env.GARCON_TEST_CONFIGURATION_GATE ?? '';
if (!validationGate) throw new Error('Configuration validation requires its isolated fixture barrier');

class GatedDirectIntegration extends DirectOpenAiCompatibleIntegration {
  constructor(host: AgentHost) {
    super(host);
    const validate = this.endpoints.validate.bind(this.endpoints);
    this.endpoints.validate = async (endpoint) => {
      await validate(endpoint);
      const response = await fetch(validationGate, {
        method: 'POST', body: JSON.stringify(endpoint), signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new AgentIntegrationError('INVALID_ENDPOINT', 'Synthetic endpoint validation refusal', false);
      }
    };
  }
}

const index = defaultAgentIntegrations.indexOf(DirectOpenAiCompatibleIntegration);
if (index < 0) throw new Error('Missing Direct integration in configuration fixture');
defaultAgentIntegrations[index] = GatedDirectIntegration;
