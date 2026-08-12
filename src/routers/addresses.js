// Address classification shared by every router driver. Lives outside the
// drivers because "is this address reachable from the internet" is the question
// the guard exists to answer — it is not specific to any one router.

// Ranges that must never be published as a "public" IP. 100.64.0.0/10 is
// RFC 6598 carrier-grade NAT — the tell-tale sign of a CGNAT'd uplink. The
// RFC1918 ranges matter just as much in practice: carriers hand out 10.x on
// mobile uplinks at least as often as they use the "official" CGNAT range.
export const NON_PUBLIC_V4 = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10], // RFC 6598 — carrier-grade NAT
  ['169.254.0.0', 16], // link-local
  ['127.0.0.0', 8],
];

export function ipToInt(ip) {
  const p = String(ip).split('.');
  if (p.length !== 4 || p.some((o) => o === '' || Number.isNaN(+o) || +o < 0 || +o > 255)) return null;
  return (((+p[0] << 24) >>> 0) + (+p[1] << 16) + (+p[2] << 8) + +p[3]) >>> 0;
}

export function inCidr(ip, base, bits) {
  const a = ipToInt(ip);
  const b = ipToInt(base);
  if (a === null || b === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

export function isNonPublicV4(ip) {
  return NON_PUBLIC_V4.some(([base, bits]) => inCidr(ip, base, bits));
}

export function isPublicV4(ip) {
  return ipToInt(ip) !== null && !isNonPublicV4(ip);
}
