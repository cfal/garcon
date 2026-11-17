import { processExitConformance } from '../../../../../common/src/lifecycle/__tests__/process-exit-conformance.js';
import { AmpCliRuntime } from '../amp-cli.js';

processExitConformance(() => new AmpCliRuntime({ terminationTimings: { termMs: 20, killMs: 20 } }));
