import { isRecord } from './json.js';

export const MAX_TRUSTED_CERTIFICATES = 16;
export const MAX_CERTIFICATE_PEM_BYTES = 64 * 1024;
export const MAX_CERTIFICATE_BUNDLE_BYTES = 256 * 1024;

export type ControllerTlsTrust =
  | { readonly kind: 'system-ca' }
  | {
      readonly kind: 'trusted-pem';
      readonly certificatesPem: readonly string[];
      readonly certificateSha256: readonly string[];
    };

export function parseControllerTlsTrust(value: unknown): ControllerTlsTrust | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'system-ca') {
    return Object.keys(value).length === 1 ? { kind: 'system-ca' } : null;
  }
  if (value.kind !== 'trusted-pem' || Object.keys(value).length !== 3) return null;
  const { certificatesPem, certificateSha256 } = value;
  if (
    !Array.isArray(certificatesPem)
    || !Array.isArray(certificateSha256)
    || certificatesPem.length < 1
    || certificatesPem.length > MAX_TRUSTED_CERTIFICATES
    || certificatesPem.length !== certificateSha256.length
  ) return null;
  let bytes = 0;
  for (const certificate of certificatesPem) {
    if (
      typeof certificate !== 'string'
      || certificate.length > MAX_CERTIFICATE_PEM_BYTES
      || !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----[\r\n \t]*$/.test(certificate)
    ) return null;
    bytes += certificate.length;
  }
  if (bytes > MAX_CERTIFICATE_BUNDLE_BYTES) return null;
  if (!certificateSha256.every((digest) => typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest))) {
    return null;
  }
  return {
    kind: 'trusted-pem',
    certificatesPem: [...certificatesPem],
    certificateSha256: [...certificateSha256],
  };
}

export function controllerTlsOptions(trust: ControllerTlsTrust): {
  readonly rejectUnauthorized: true;
  readonly ca?: string[];
} {
  return trust.kind === 'trusted-pem'
    ? { ca: [...trust.certificatesPem], rejectUnauthorized: true }
    : { rejectUnauthorized: true };
}
