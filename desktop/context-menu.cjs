'use strict';
// The mail window's right-click menu (operator, 2026-10-21): on a link or a button in a message,
// Open Link in Browser and Copy Link, as in any mail app; on selected text, Copy; in a field, the
// usual editing items. Electron shows no menu of its own, so without this a link could only be
// clicked. B-227 (operator, 2026-11-06): each installed browser in the same menu, "Open in Safari", "Open in
// Chrome"…, not a submenu (desktop/browsers.cjs finds them). Pure: main.cjs passes the opener and the clipboard,
// tests pass fakes.

/** Links a person may open or copy: web pages and mail addresses; anything else is not offered. */
function linkOf(params) {
  const url = typeof params.linkURL === 'string' ? params.linkURL : '';
  return /^(https?:|mailto:)/i.test(url) ? url : '';
}

/**
 * The menu's items for one right-click, or [] when there is nothing to offer (no menu then).
 * `actions.open(url)` opens a link in the default browser, `actions.copy(text)` puts text on the clipboard,
 * `actions.openIn(browser, url)` opens it in one of `actions.browsers` (listed when there are two or more).
 */
function contextMenuTemplate(params, { t, open, copy, browsers = [], openIn }) {
  const items = [];
  const link = linkOf(params);
  if (link) {
    items.push({ label: link.startsWith('mailto:') ? t('Write to This Address') : t('Open Link in Browser'), click: () => open(link) });
    if (!link.startsWith('mailto:') && openIn && browsers.length > 1)
      for (const b of browsers) items.push({ label: t('Open in {browser}', { browser: b.name }), click: () => openIn(b, link) });
    items.push({ label: link.startsWith('mailto:') ? t('Copy Address') : t('Copy Link'), click: () => copy(link.startsWith('mailto:') ? link.slice(7).split('?')[0] : link) });
  }
  const flags = params.editFlags || {};
  if (params.isEditable) {
    if (items.length) items.push({ type: 'separator' });
    items.push({ role: 'cut', label: t('Cut'), enabled: !!flags.canCut });
    items.push({ role: 'copy', label: t('Copy'), enabled: !!flags.canCopy });
    items.push({ role: 'paste', label: t('Paste'), enabled: !!flags.canPaste });
    items.push({ role: 'selectAll', label: t('Select All') });
  } else if (typeof params.selectionText === 'string' && params.selectionText.trim()) {
    if (items.length) items.push({ type: 'separator' });
    items.push({ role: 'copy', label: t('Copy') });
  }
  return items;
}

module.exports = { contextMenuTemplate, linkOf };
