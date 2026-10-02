let taskId;
let task;
let items;

self.onmessage = ({ data }) => {
  if (data.type === 'begin') {
    taskId = data.taskId;
    task = data.task;
    items = [];
  } else if (data.type === 'items') {
    items.push(...data.items);
  } else if (data.type === 'run') {
    switch (task.kind) {
      case 'crash':
        throw new Error('synthetic worker failure');
      case 'exit':
        process.exit(0);
        break;
      case 'malformed':
        self.postMessage({ type: 'invalid', taskId });
        break;
      case 'wrong-task':
        self.postMessage({ type: 'result', taskId: taskId + 1, result: 'wrong task' });
        break;
      case 'task-error':
        self.postMessage({ type: 'failed', taskId, message: 'synthetic task failure', code: 'SYNTHETIC' });
        break;
      case 'echo':
        self.postMessage({ type: 'result', taskId, result: items });
        break;
    }
  }
};
