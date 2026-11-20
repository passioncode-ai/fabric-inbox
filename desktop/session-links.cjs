'use strict';
// B-305 (SCN-106): Fabric's session links from Fabric Inbox. Fabric owns starting, opening and continuing a coding
// session (`fabric-session-links/1`, Fabric's answer on board thread 3ca40854, built on the `fabric://` links of
// fabric-agent-contract DEC-0040); Inbox only builds the link and hands it to the system, which opens Fabric. A link
// carries ids only (no words, no secret) and opens a view: Fabric asks the person before it starts or moves anything.
//
//   new       fabric://session/new?project=<id or name>&runner=<kind>&from=fabric-inbox
//   open      fabric://session/open?session=<id>&from=fabric-inbox
//   continue  fabric://session/continue?session=<id>&from=fabric-inbox
//
// Everything outside (the protocol lookup, opening a URL, the profile folder) is passed in, so this file runs in tests.
const path = require('node:path');

const FROM = 'fabric-inbox';
/** A project id or name as DEC-0040 takes one: no slash, no space, no percent sign. */
const PROJECT_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** A runner kind as Fabric's runner catalogue names one. */
const RUNNER_KIND = /^[a-z][a-z0-9-]{1,62}$/;
/**
 * A session id as the contract takes one (fabric-agent-contract DEC-0189 SL-2, `src/fabric-links.ts` SESSION_ID): a
 * Fabric session's or a runner session's UUID in its 8-4-4-4-12 hex form, sent lower-case. Any other shape Fabric
 * refuses, so it is refused here before anything opens.
 */
const SESSION_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** The console's runtimes (desktop/console.cjs RUNTIMES) by the runner kind Fabric knows them as. */
const RUNNERS = { claude: 'claude-code', codex: 'codex' };
const MAX_LINK_LENGTH = 2048;

/** Builds one link; answers `{ ok, url }` or `{ ok: false, error }` naming the field that is not an id. */
function sessionLink(input) {
  const action = input && input.action;
  const params = new URLSearchParams();
  if (action === 'new') {
    const project = String(input.project ?? '').trim();
    if (!PROJECT_REF.test(project)) return { ok: false, error: 'project' };
    params.set('project', project);
    if (input.runner !== undefined && input.runner !== null && input.runner !== '') {
      const runner = RUNNERS[input.runner] || String(input.runner);
      if (!RUNNER_KIND.test(runner)) return { ok: false, error: 'runner' };
      params.set('runner', runner);
    }
  } else if (action === 'open' || action === 'continue') {
    const session = String(input.session ?? '');
    if (!SESSION_ID.test(session)) return { ok: false, error: 'session' };
    params.set('session', session.toLowerCase());
  } else {
    return { ok: false, error: 'action' };
  }
  params.set('from', FROM);
  const url = `fabric://session/${action}?${params}`;
  return url.length > MAX_LINK_LENGTH ? { ok: false, error: 'length' } : { ok: true, url };
}

/**
 * Hands a link to the system. Fabric absent (no app registered for `fabric://`) answers `not_installed` before anything
 * is opened; a refusal of the system answers `open`. deps: { appForProtocol(url) → app name or '', openExternal(url) }.
 */
async function openSessionLink(url, { appForProtocol, openExternal }) {
  let handler = '';
  try { handler = appForProtocol('fabric://') || ''; } catch { handler = ''; }
  if (!handler) return { ok: false, error: 'not_installed' };
  try { await openExternal(url); return { ok: true }; } catch { return { ok: false, error: 'open' }; }
}

/** The Fabric projects a person sent sessions to, newest first, kept in the profile so the next start offers them. */
const PROJECTS_FILE = 'fabric-projects.json';
const PROJECTS_KEPT = 8;
async function readProjects(fsp, userData) {
  try {
    const list = JSON.parse(await fsp.readFile(path.join(userData, PROJECTS_FILE), 'utf8'));
    return Array.isArray(list) ? list.filter((p) => typeof p === 'string' && PROJECT_REF.test(p)).slice(0, PROJECTS_KEPT) : [];
  } catch { return []; }
}
async function rememberProject(fsp, userData, project) {
  if (!PROJECT_REF.test(project)) return readProjects(fsp, userData);
  const list = [project, ...(await readProjects(fsp, userData)).filter((p) => p !== project)].slice(0, PROJECTS_KEPT);
  await fsp.writeFile(path.join(userData, PROJECTS_FILE), JSON.stringify(list), { mode: 0o600 });
  return list;
}

module.exports = { sessionLink, openSessionLink, readProjects, rememberProject, FROM, RUNNERS, PROJECT_REF, SESSION_ID, PROJECTS_FILE, PROJECTS_KEPT };
