import { processExitConformance } from '../../../../../common/src/lifecycle/__tests__/process-exit-conformance.js';
import { FactoryCliRuntime } from '../factory-cli.js';

processExitConformance(() => new FactoryCliRuntime({ terminationTimings: { termMs: 20, killMs: 20 } }));
