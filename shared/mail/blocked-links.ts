/** B-180: whether a link goes to one of `hosts` (known phishing sites a message links to) or a host under one. */
export function isBlockedLink(href: string | null, hosts: readonly string[]): boolean {
  if (!href || !hosts.length) return false;
  let host = "";
  try { host = new URL(href).hostname.toLowerCase(); } catch { return false; }
  return hosts.some((h) => host === h || host.endsWith("." + h));
}
