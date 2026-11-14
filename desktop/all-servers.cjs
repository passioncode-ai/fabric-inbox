'use strict';
/**
 * B-233 (SCN-099; operator, 2026-11-07: "хочу все аккаунты в одном окне как были"): the inbox of every
 * server the app holds, in one list. Since B-244 the list is the mail window's (its All tab): this reads the other
 * servers for the page's bridge (main.cjs `fabric:other-inbox`). Each server is read through its own session (its own sign-in), never
 * through another's; nothing is copied between servers, and a message opens on its own server. One server
 * that is signed out or does not answer never hides the others: it gets a state of its own.
 *
 * Pure apart from what is passed in: `read(origin, path)` answers { status, body } (status 401 for a
 * sign-in redirect), as main.cjs's serverApi does; tests pass fakes.
 */
const { messageLink } = require('./new-mail.cjs');

const PAGE_SIZE = 50;
const INBOX_PATH = `/api/inbox?folder=inbox&limit=${PAGE_SIZE}`;
/** How many messages the merged list keeps, newest first. */
const LIST_MAX = 300;

/** One server's state from its answer: ok, signed_out (Access sent it to the sign-in page) or unreachable. */
function stateOf(answer) {
  if (!answer) return 'unreachable';
  if (answer.status === 401 || answer.status === 403) return 'signed_out';
  if (answer.status !== 200 || !answer.body || !Array.isArray(answer.body.messages)) return 'unreachable';
  return 'ok';
}

/** A message of one server's inbox as the list shows it; null for a row it cannot open. */
function rowOf(server, m) {
  if (!m || typeof m.accountId !== 'string' || typeof m.providerMessageId !== 'string') return null;
  const at = Number(m.timestamp) || Date.parse(m.date) || 0;
  return {
    origin: server.origin, server: server.label,
    sender: typeof m.sender === 'string' ? m.sender : '', to: typeof m.recipient === 'string' ? m.recipient : '', subject: typeof m.subject === 'string' ? m.subject : '',
    snippet: typeof m.snippet === 'string' ? m.snippet.slice(0, 200) : '',
    at, read: !!m.read, link: messageLink(m.accountId, m.providerMessageId),
  };
}

/**
 * Reads every server at once and merges their inboxes. servers: [{ origin, label }].
 * Answers { servers: [{ origin, label, state, unread, full }], messages: [row, …] } (messages newest first).
 */
async function readAll({ servers, read }) {
  const answers = await Promise.all(servers.map(async (s) => {
    let answer;
    try { answer = await read(s.origin, INBOX_PATH); } catch { answer = null; }
    return { server: s, answer };
  }));
  const rows = [];
  const states = answers.map(({ server, answer }) => {
    const state = stateOf(answer);
    const mine = state === 'ok' ? answer.body.messages.map((m) => rowOf(server, m)).filter(Boolean) : [];
    rows.push(...mine);
    // S01 (B-267): a read that came back full counts unread among its last PAGE_SIZE rows only, a lower bound ("50+").
    return { origin: server.origin, label: server.label, state, unread: state === 'ok' ? mine.filter((r) => !r.read).length : null,
      full: state === 'ok' && answer.body.messages.length >= PAGE_SIZE };
  });
  rows.sort((a, b) => b.at - a.at);
  return { servers: states, messages: rows.slice(0, LIST_MAX) };
}

module.exports = { readAll, stateOf, rowOf, INBOX_PATH, PAGE_SIZE, LIST_MAX };
