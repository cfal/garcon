import { singleQueryIoConformance } from '../../../../../common/src/shared/__tests__/single-query-io-conformance.js';
import { runSingleQuery } from '../pi-cli.js';

singleQueryIoConformance(prompt => runSingleQuery(prompt, { model: 'synthetic-model' }, {
  binary: () => 'synthetic-pi', sessionDirectoryOverride: () => null,
  agentDirectoryOverride: () => null,
  homeDirectory: () => '/workspace', isTestEnvironment: () => true,
}));
