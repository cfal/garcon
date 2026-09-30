import { serveTaskWorker } from '../../lib/task-worker-host.js';
import {
  runTranscriptRenderingTask,
  TRANSCRIPT_RENDERING_TASK_KINDS,
  type TranscriptRenderingTask,
} from './tasks.js';

serveTaskWorker<TranscriptRenderingTask>(
  'Transcript rendering',
  TRANSCRIPT_RENDERING_TASK_KINDS,
  runTranscriptRenderingTask,
);
