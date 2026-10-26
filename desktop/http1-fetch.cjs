// B-175: a fetch that speaks HTTP/1.1 only, for the server deploy run from Node (scripts/onboard.mjs).
// Node 26's own fetch opens HTTP/2 to Cloudflare's API; on 2026-10-26 every asset upload of a deploy
// died with "bad record mac" and then "The session has been destroyed", and the deploy stopped as a
// network error. This one uses node:https, a connection per request, and no dependency. A FormData body
// is turned into its multipart bytes and header by Node's own Response first.
'use strict';
const http = require('node:http');
const https = require('node:https');

// A fresh connection per request: a kept-alive socket Cloudflare had closed failed the server upload
// with a reset (seen 2026-10-26, after 23 asset uploads went through).
const agents = { 'http:': new http.Agent({ keepAlive: false }), 'https:': new https.Agent({ keepAlive: false }) };

async function bodyOf(init) {
  const body = init.body;
  if (body === undefined || body === null) return { headers: {}, bytes: null };
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const r = new Response(body);
    return { headers: { 'Content-Type': r.headers.get('content-type') }, bytes: Buffer.from(await r.arrayBuffer()) };
  }
  if (typeof body === 'string') return { headers: {}, bytes: Buffer.from(body) };
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return { headers: {}, bytes: Buffer.from(body) };
  if (body instanceof ArrayBuffer) return { headers: {}, bytes: Buffer.from(body) };
  throw new TypeError('http1Fetch: unsupported body');
}

async function http1Fetch(input, init = {}) {
  const url = new URL(String(input));
  const lib = url.protocol === 'https:' ? https : url.protocol === 'http:' ? http : null;
  if (!lib) throw new TypeError(`http1Fetch: unsupported protocol ${url.protocol}`);
  const { headers: extra, bytes } = await bodyOf(init);
  const headers = { ...Object.fromEntries(new Headers(init.headers || {}).entries()), ...extra };
  if (bytes) headers['content-length'] = String(bytes.length);
  const signal = init.signal;
  if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
  return new Promise((resolve, reject) => {
    const req = lib.request(url, { method: init.method || 'GET', headers, agent: agents[url.protocol] }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const responseHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) for (const one of [].concat(v)) responseHeaders.append(k, one);
        // A status with no body (204, 304) cannot carry one in a Response.
        const empty = res.statusCode === 204 || res.statusCode === 304;
        resolve(new Response(empty ? null : Buffer.concat(chunks), { status: res.statusCode, statusText: res.statusMessage, headers: responseHeaders }));
      });
    });
    const onAbort = () => req.destroy(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (error) => { signal?.removeEventListener('abort', onAbort); reject(error); });
    req.on('close', () => signal?.removeEventListener('abort', onAbort));
    if (bytes) req.write(bytes);
    req.end();
  });
}

module.exports = { http1Fetch };
