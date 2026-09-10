import { describe, expect, test } from 'bun:test';
import { NodeEnrollmentTransport } from '../trust.js';
import type { RequestIpServer } from '../../lib/rate-limit.js';

const peer = (address: string) => ({ requestIP: () => ({ address }) }) satisfies RequestIpServer;

describe('enrollment transport authority', () => {
  test('requires the real TLS listener, not just an HTTPS URL', () => {
    const secure = new NodeEnrollmentTransport({ listenerUsesTls: true });
    const plaintext = new NodeEnrollmentTransport({ listenerUsesTls: false });
    expect(secure.isSecure(new Request('https://controller.test/enroll'))).toBe(true);
    expect(secure.isSecure(new Request('http://controller.test/enroll'))).toBe(false);
    expect(plaintext.isSecure(new Request('https://controller.test/enroll'))).toBe(false);
  });

  test('trusts proxy HTTPS metadata only from an explicitly allowed physical peer', () => {
    const addresses = ['192.0.2.1', '::1'];
    const transport = new NodeEnrollmentTransport({ listenerUsesTls: false, trustedProxyAddresses: addresses });
    addresses.push('192.0.2.2');
    const request = new Request('http://controller.test/enroll', { headers: { 'X-Forwarded-Proto': 'https' } });
    expect(transport.isSecure(request, peer('192.0.2.1'))).toBe(true);
    expect(transport.isSecure(request, peer('::1'))).toBe(true);
    expect(transport.isSecure(request, peer('192.0.2.2'))).toBe(false);
    expect(transport.isSecure(request)).toBe(false);
    expect(transport.isSecure(request, { requestIP: () => { throw new Error('Synthetic failure'); } })).toBe(false);
    for (const forwarded of ['http', 'https,http', 'https, https', 'HTTPS', '']) {
      expect(transport.isSecure(new Request(request.url, { headers: { 'X-Forwarded-Proto': forwarded } }), peer('192.0.2.1'))).toBe(false);
    }
    const spoofedHeaders: HeadersInit[] = [
      { 'X-Forwarded-For': '192.0.2.1', 'X-Forwarded-Proto': 'https' },
      { 'X-Real-IP': '192.0.2.1', 'X-Forwarded-Proto': 'https' },
      { Forwarded: 'for=192.0.2.1;proto=https' },
    ];
    for (const headers of spoofedHeaders) expect(transport.isSecure(new Request(request.url, { headers }), peer('192.0.2.2'))).toBe(false);
  });

  test('normalizes equivalent IPv6 and mapped IPv4 physical peer addresses', () => {
    const request = new Request('http://controller.test/enroll', { headers: { 'X-Forwarded-Proto': 'https' } });
    for (const addresses of [['192.0.2.1', '::ffff:192.0.2.1', '0:0:0:0:0:ffff:c000:201'], ['::1', '0:0:0:0:0:0:0:1']]) {
      for (const configured of addresses) {
        const transport = new NodeEnrollmentTransport({ listenerUsesTls: false, trustedProxyAddresses: [configured] });
        for (const address of addresses) expect(transport.isSecure(request, peer(address))).toBe(true);
        expect(transport.isSecure(request, peer('192.0.2.2'))).toBe(false);
      }
    }
  });

  test('rejects hostname, CIDR, and wildcard proxy authority', () => {
    for (const address of ['localhost', '*', '192.0.2.0/24', '', '192.0.2.1:443']) {
      expect(() => new NodeEnrollmentTransport({ listenerUsesTls: false, trustedProxyAddresses: [address] })).toThrow();
    }
  });
});
