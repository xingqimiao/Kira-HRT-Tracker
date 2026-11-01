import type { IncomingHttpHeaders } from 'node:http';
export type TrustedIpSource = 'socket' | 'cf' | 'xff';

/**
 * The parts of a request this module reads.
 *
 * Narrower than `IncomingMessage` on purpose: a test can pass `{ headers, socket }`
 * without fabricating a `net.Socket`, and the compiler still checks what matters —
 * `remoteAddress` exists and headers are a string map.
 */
export type ClientIpRequest = {
  headers: IncomingHttpHeaders;
  socket: { remoteAddress?: string | null };
};

/** Header modes require an isolated origin and a proxy that overwrites the selected header. */
export function clientIp(req: ClientIpRequest, source: TrustedIpSource): string {
  const socket = (req.socket.remoteAddress ?? 'unknown').trim().slice(0, 64);
  const header = source === 'cf' ? req.headers['cf-connecting-ip'] : source === 'xff' ? req.headers['x-forwarded-for'] : undefined;
  if (typeof header !== 'string') return socket;
  const value = source === 'xff' ? header.split(',').pop() : header;
  return value?.trim().slice(0, 64) || socket;
}

/**
 * Warn once when a forwarding header proves the socket address is not the client.
 *
 * `socket` is the right default: a client can forge any header, so only the socket
 * address is trustworthy by itself. Behind a proxy it is also wrong — every request
 * then carries the proxy's address, so all users share one rate-limit bucket and a
 * single host can exhaust it. That misconfiguration looks healthy, so it is called
 * out once instead of failing silently.
 *
 * A factory rather than module-level state so a test can own its own "already
 * warned" flag and assert the one-shot behaviour without depending on test order.
 */
export function createProxyMisconfigurationWarner(
  warn: (message: string) => void = console.warn,
): (headers: IncomingHttpHeaders, source: TrustedIpSource) => void {
  let warned = false;
  return (headers, source) => {
    if (warned || source !== 'socket') return;
    if (!headers['x-forwarded-for'] && !headers['cf-connecting-ip']) return;
    warned = true;
    warn('[hrt] TRUSTED_IP_SOURCE=socket but a forwarding header arrived: '
      + 'every client shares one rate-limit bucket. Set TRUSTED_IP_SOURCE=xff or cf '
      + 'behind a proxy that overwrites that header.');
  };
}
