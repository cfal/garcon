import {
  MAX_NODE_ENROLLMENT_EXCHANGE_BYTES, NODE_ENROLLMENT_TIMEOUT_MS,
  NODE_PAIRING_ERROR_CODES, parseNodeEnrollmentBundle, parseNodeEnrollmentResponse,
  type ExecutionNodePairing, type NodeEnrollmentBundle, type NodeEnrollmentRequest,
} from '../../common/execution-node-config.js';
import { controllerTlsOptions } from '../../common/controller-tls.js';
import { verifyControllerTlsTrust } from '../../common/controller-tls-node.js';
import { isRecord } from '../../common/json.js';
import { readBoundedJsonBody } from '../../common/bounded-json-body.js';

type PairingFailureCode = typeof NODE_PAIRING_ERROR_CODES[number] | 'NODE_TLS_UNTRUSTED';
export type NodeTlsFailureReason = 'certificate-expired' | 'hostname-mismatch' | 'certificate-untrusted';
type EnrollmentFetchOptions = RequestInit & { readonly tls: ReturnType<typeof controllerTlsOptions> };

export class NodeEnrollmentClientError extends Error {
  readonly retryable: boolean;
  readonly tlsReason: NodeTlsFailureReason | undefined;

  constructor(readonly code: PairingFailureCode, message: string, options: {
    readonly retryable?: boolean; readonly tlsReason?: NodeTlsFailureReason;
  } = {}) {
    super(message);
    this.name = 'NodeEnrollmentClientError';
    this.retryable = options.retryable ?? false;
    this.tlsReason = options.tlsReason;
  }
}

/** Sends one exchange over the verified connection; no probe, redirect, retry, or credential recovery. */
export async function enrollExecutionNode(
  bundle: NodeEnrollmentBundle,
  signal: AbortSignal,
  options: { readonly fetch?: (url: string, init: EnrollmentFetchOptions) => Promise<Response> } = {},
): Promise<ExecutionNodePairing> {
  const captured = parseNodeEnrollmentBundle(bundle);
  if (!captured) throw new NodeEnrollmentClientError('NODE_ENROLLMENT_INVALID', 'Invalid node enrollment bundle');
  let trust;
  try { trust = verifyControllerTlsTrust(captured.trust); }
  catch { throw new NodeEnrollmentClientError('NODE_TLS_UNTRUSTED', 'Controller certificate trust or fingerprint is invalid', { tlsReason: 'certificate-untrusted' }); }
  if (signal.aborted) throw cancelledBeforeTransmission();
  if (Date.now() >= Date.parse(captured.expiresAt)) {
    throw new NodeEnrollmentClientError('NODE_ENROLLMENT_EXPIRED', 'Node enrollment expired; request a new bundle');
  }
  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(new Error('Enrollment timed out')), NODE_ENROLLMENT_TIMEOUT_MS);
  const requestSignal = AbortSignal.any([signal, deadline.signal]);
  const cancelled = Promise.withResolvers<never>();
  let fetchEntered = false;
  const abort = () => cancelled.reject(fetchEntered ? unknownEnrollment() : cancelledBeforeTransmission());
  requestSignal.addEventListener('abort', abort, { once: true });
  let response: Response | undefined;
  try {
    const request: NodeEnrollmentRequest = {
      version: 1, controllerId: captured.controllerId, nodeId: captured.nodeId, token: captured.token,
    };
    const pending = Promise.resolve().then(() => {
      if (requestSignal.aborted) throw cancelledBeforeTransmission();
      fetchEntered = true;
      return (options.fetch ?? fetch)(`${captured.controllerUrl}/api/v1/execution-nodes/enroll`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
        tls: controllerTlsOptions(trust), redirect: 'error', signal: requestSignal,
      }).catch((error: unknown) => {
        if (isRecord(error) && ['ConnectionRefused', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(String(error.code))) {
          throw new NodeEnrollmentClientError('NODE_PAIRING_UNAVAILABLE',
            'Could not connect to the controller; try this bundle again after restoring connectivity', { retryable: true });
        }
        throw error;
      });
    }).then((received) => {
      if (requestSignal.aborted) {
        void received.body?.cancel().catch(() => {});
        throw unknownEnrollment();
      }
      return received;
    });
    response = await Promise.race([pending, cancelled.promise]);
    const body = await readBoundedJsonBody(response, MAX_NODE_ENROLLMENT_EXCHANGE_BYTES, requestSignal);
    requestSignal.throwIfAborted();
    if (!response.ok) {
      if (!isRecord(body) || !NODE_PAIRING_ERROR_CODES.some((code) => code === body.errorCode)) throw unknownEnrollment();
      const code = body.errorCode as typeof NODE_PAIRING_ERROR_CODES[number];
      const retryable = body.retryable === true;
      if (code === 'NODE_PAIRING_UNAVAILABLE' && !retryable) throw unknownEnrollment();
      const guidance = retryable ? 'try this bundle again later'
        : code === 'NODE_TLS_REQUIRED' || code === 'NODE_ADMIN_REQUIRED'
          ? 'correct the controller configuration before trying this bundle again' : 'request a new bundle';
      throw new NodeEnrollmentClientError(code, `Controller rejected node enrollment (HTTP ${response.status}); ${guidance}`, { retryable });
    }
    const paired = parseNodeEnrollmentResponse(body);
    if (!paired || paired.controllerId !== captured.controllerId || paired.nodeId !== captured.nodeId) throw unknownEnrollment();
    return { ...paired, controllerUrl: captured.controllerUrl, trust };
  } catch (error) {
    if (error instanceof NodeEnrollmentClientError) throw error;
    const reason = tlsFailureReason(error);
    if (reason) {
      const message = reason === 'certificate-expired' ? 'Controller certificate expired'
        : reason === 'hostname-mismatch' ? 'Controller certificate hostname mismatch' : 'Controller certificate not trusted';
      throw new NodeEnrollmentClientError('NODE_TLS_UNTRUSTED', message, { tlsReason: reason });
    }
    throw unknownEnrollment();
  } finally {
    clearTimeout(timeout);
    requestSignal.removeEventListener('abort', abort);
    void response?.body?.cancel().catch(() => {});
  }
}

function tlsFailureReason(error: unknown): NodeTlsFailureReason | null {
  if (!isRecord(error)) return null;
  const code = error.code;
  if (code === 'CERT_HAS_EXPIRED') return 'certificate-expired';
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') return 'hostname-mismatch';
  if (code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return 'certificate-untrusted';
  return typeof code === 'string' && /CERT|CERTIFICATE|ISSUER|SELF_SIGNED/.test(code) ? 'certificate-untrusted' : null;
}

function unknownEnrollment(): NodeEnrollmentClientError {
  return new NodeEnrollmentClientError('NODE_PAIRING_UNAVAILABLE',
    'Node enrollment outcome is unknown; revoke and reissue the bundle before retrying');
}

function cancelledBeforeTransmission(): NodeEnrollmentClientError {
  return new NodeEnrollmentClientError('NODE_ENROLLMENT_CANCELLED', 'Node enrollment cancelled before transmission');
}
