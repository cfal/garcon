import { serveTaskWorker } from '../../lib/task-worker-host.js';
import { runTokenFittingTask, TOKEN_FITTING_TASK_KINDS, type TokenFittingTask } from './tasks.js';

serveTaskWorker<TokenFittingTask>('Token fitting', TOKEN_FITTING_TASK_KINDS, runTokenFittingTask);
