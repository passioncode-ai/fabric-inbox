'use strict';
const { t } = require('./i18n.cjs');
const { createHash } = require('node:crypto');

function parseWebURL(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) return null;
    return url;
  } catch { return null; }
}
function loopback(hostname) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
}
function serverOrigin(value) {
  const url = parseWebURL(typeof value === 'string' ? value.trim() : value);
  if (!url || (url.protocol !== 'https:' && !loopback(url.hostname))) {
    throw new Error(t('Use an HTTPS server address, or HTTP on localhost for development.'));
  }
  if (url.pathname !== '/' || url.search || url.hash) throw new Error(t('Enter the server origin without a path, query or fragment.'));
  return url.origin;
}
function accessOrigin(value) {
  if (!value) return '';
  const url = parseWebURL(typeof value === 'string' ? value.trim() : value);
  if (!url || url.protocol !== 'https:' || url.port || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(url.hostname) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(t('Use your exact HTTPS Cloudflare Access team address.'));
  }
  return url.origin;
}
function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(t('Enter a server address.'));
  return { origin: serverOrigin(value.origin), accessOrigin: accessOrigin(value.accessOrigin) };
}
function navigation(urlString, config) {
  const url = parseWebURL(urlString);
  if (!url) return 'deny';
  if (url.origin === config.origin && url.pathname === '/api/accounts/gmail/connect') return 'gmail';
  if (url.origin === config.origin || (config.accessOrigin && url.origin === config.accessOrigin)) return 'internal';
  // Do not offer unencrypted non-loopback destinations to the OS browser.
  if (url.protocol === 'https:' || loopback(url.hostname)) return 'external';
  return 'deny';
}
function gmailConnectURL(config) { return new URL('/api/accounts/gmail/connect', config.origin).href; }
/** Where the server opens after Create my server: Domains, or the Gmail setup when it was asked for (SCN-030, SCN-051). */
function afterDeployPage(input) { return input && input.gmail === true ? '/settings/accounts?connect=gmail' : '/settings/domains'; }
function partitionFor(config) { return `persist:fabric-${createHash('sha256').update(config.origin).digest('hex').slice(0, 24)}`; }
function isSetupSender(event, setupWindow, setupURL) {
  return Boolean(setupWindow && !setupWindow.isDestroyed() && event.sender === setupWindow.webContents && event.senderFrame === setupWindow.webContents.mainFrame && event.senderFrame.url === setupURL);
}
const SETUP_FORMAT = 'fabric-inbox-setup/1';
const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ADDRESS = /^[^\s@]{1,64}@[^\s@]{3,253}$/;
/**
 * Reads a setup file far enough for the desktop to show and use it: the server
 * part is validated like a typed server address; domains and mailboxes are
 * checked for shape and counted. The server validates the rest when applying.
 * Returns { ok, summary, setup } or { ok: false, error }.
 */
function readSetup(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: t('This file is not a Fabric Inbox setup.') };
  if (value.format !== SETUP_FORMAT) return { ok: false, error: t('This file is not a Fabric Inbox setup (unknown format).') };
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100) return { ok: false, error: t('The setup has no name.') };
  let config;
  try { config = validateConfig({ origin: value.server?.origin, accessOrigin: value.server?.accessOrigin || '' }); }
  catch (error) { return { ok: false, error: t('Its server address cannot be used: {reason}', { reason: error.message }) }; }
  const domains = Array.isArray(value.domains) ? value.domains : [];
  const mailboxes = Array.isArray(value.mailboxes) ? value.mailboxes : [];
  const notServed = Array.isArray(value.notServed) ? value.notServed : [];
  if (domains.length > 200 || mailboxes.length > 500) return { ok: false, error: t('The setup is larger than one server serves.') };
  if (!domains.every(d => typeof d === 'string' && DOMAIN.test(d))) return { ok: false, error: t('The setup lists a domain that is not a domain name.') };
  if (!mailboxes.every(m => m && typeof m.address === 'string' && ADDRESS.test(m.address))) return { ok: false, error: t('The setup lists an address that is not an email address.') };
  const byDomain = domains.map(domain => ({
    domain,
    addresses: mailboxes.filter(m => m.address.toLowerCase().endsWith('@' + domain)).map(m => ({
      address: m.address.toLowerCase(), forwardTo: typeof m.forwardTo === 'string' ? m.forwardTo : '' })),
  }));
  return {
    ok: true,
    setup: value,
    summary: {
      name: value.name.trim(), origin: config.origin, accessOrigin: config.accessOrigin,
      domainCount: domains.length, mailboxCount: mailboxes.length, byDomain,
      notServed: notServed.filter(n => n && typeof n.domain === 'string').map(n => ({ domain: n.domain, reason: String(n.reason || '').slice(0, 300) })),
    },
  };
}
function isMailSender(event, mailWindow, config) {
  if (!mailWindow || mailWindow.isDestroyed() || !config || event.sender !== mailWindow.webContents || event.senderFrame !== mailWindow.webContents.mainFrame) return false;
  try { return new URL(event.senderFrame.url).origin === config.origin; } catch { return false; }
}
module.exports = { serverOrigin, accessOrigin, validateConfig, navigation, gmailConnectURL, afterDeployPage, partitionFor, isSetupSender, readSetup, isMailSender, SETUP_FORMAT };
