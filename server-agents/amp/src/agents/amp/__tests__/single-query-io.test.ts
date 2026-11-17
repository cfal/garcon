import { singleQueryIoConformance } from '../../../../../common/src/shared/__tests__/single-query-io-conformance.js';
import { runSingleQuery } from '../amp-cli.js';

singleQueryIoConformance(prompt => runSingleQuery(prompt, {}, { binary: () => 'synthetic-amp' }));
