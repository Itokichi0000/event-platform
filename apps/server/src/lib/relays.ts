/** Space- or comma-separated ws(s) URLs. Throws on an invalid entry. */
export function parseRelays(value: string): string[] {
  const list = value.split(/[\s,]+/).filter(Boolean);
  for (const url of list) {
    const u = new URL(url);
    if (u.protocol !== 'wss:' && u.protocol !== 'ws:') throw new Error(`not a relay URL: ${url}`);
  }
  return [...new Set(list)];
}
