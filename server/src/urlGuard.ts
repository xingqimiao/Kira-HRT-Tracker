/**
 * Host screening for outbound URLs, so the server never fetches an address it was not
 * meant to reach.
 *
 * A provider OAuth token response names the avatar URL, and that value is parsed rather
 * than verified — so before the server requests it, the host has to be checked. `https:`
 * alone is not enough: a URL can name the loopback interface or a link-local address
 * (`169.254.169.254`, the cloud metadata endpoint) and still be a well-formed `https:`
 * URL. This module is the check; callers do the requesting and re-check on every redirect
 * hop, because a public host can answer a redirect to an internal one.
 *
 * `ponytail:` this screens the literal host, not where a public name resolves, so a
 * rebinding DNS answer could still point at an internal address. The upgrade path is to
 * resolve the name and pin the connection to the resolved address.
 */
import { isIPv4, isIPv6 } from 'node:net';

/** Hostnames that name a local or internal service. */
const LOCAL_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

/** IPv4 first octets with no publicly routable host. */
const NON_ROUTABLE_FIRST_OCTET = [0, 10, 127];

/**
 * Whether a dotted-quad IPv4 address is one the server refuses to fetch from: "this
 * network", private, loopback, CGNAT, link-local, the reserved/test blocks, and
 * multicast-and-above. No provider CDN lives in any of them.
 */
function blockedIpv4(octets: number[]): boolean {
  if (octets.some((n) => Number.isNaN(n))) return true;
  if (octets.some((n) => n > 255)) return true;
  const [a, b] = octets;
  if (NON_ROUTABLE_FIRST_OCTET.includes(a)) return true;
  if (a >= 224) return true;
  if (a === 100) {
    if (b >= 64) {
      if (b <= 127) return true;
    }
  }
  if (a === 169) {
    if (b === 254) return true;
  }
  if (a === 172) {
    if (b >= 16) {
      if (b <= 31) return true;
    }
  }
  if (a === 192) {
    if (b === 0) return true;
    if (b === 168) return true;
  }
  if (a === 198) {
    if (b === 18) return true;
    if (b === 19) return true;
    if (b === 51) return true;
  }
  if (a === 203) {
    if (b === 0) return true;
  }
  return false;
}

/** Whether an IPv6 address is loopback, unspecified, unique-local, link-local, or multicast. */
function blockedIpv6(addr: string): boolean {
  if (addr === '::1') return true;
  if (addr === '::') return true;
  const head = parseInt(addr.split(':')[0], 16);
  if (Number.isNaN(head)) return true;
  if ((head & 0xfe00) === 0xfc00) return true;
  if ((head & 0xffc0) === 0xfe80) return true;
  if ((head & 0xff00) === 0xff00) return true;
  return false;
}

/** Whether a host must not be fetched. IPv4-mapped IPv6 literals (`::ffff:127.0.0.1`) unwrap to IPv4. */
export function isBlockedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  const host = lower.endsWith('.') ? lower.slice(0, -1) : lower;
  if (host === 'localhost') return true;
  if (LOCAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;

  const bare = host.startsWith('[') ? host.slice(1, -1) : host;
  const lastColon = bare.lastIndexOf(':');
  if (lastColon >= 0) {
    const tail = bare.slice(lastColon + 1);
    if (isIPv4(tail)) return blockedIpv4(tail.split('.').map(Number));
    if (isIPv6(bare)) return blockedIpv6(bare);
    return false;
  }

  if (isIPv4(bare)) return blockedIpv4(bare.split('.').map(Number));
  return false;
}
