import { NodeWorkerServiceClient } from '../../server/execution-node/worker/service-channel.js';

const receive = NodeWorkerServiceClient.prototype.receive;
NodeWorkerServiceClient.prototype.receive = function (frame) {
  if (frame.type === 'node-worker-service-result' && frame.result.kind === 'provider-auth-rejected'
    && frame.result.code === 'OPERATION_UNSUPPORTED') {
    receive.call(this, { ...frame, result: { kind: 'provider-login-completed', instanceId: frame.result.instanceId,
      result: { submitted: true, sessionId: 'synthetic-foreign-login' } } });
    return;
  }
  receive.call(this, frame);
};
