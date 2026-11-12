'use strict';
// B-244 D-1 (SCN-093, SCN-099; operator, 2026-11-11: «чтобы они все показывались внутри одного окна, я бы не
// переключался между ними, не щелкал этими окнами»): the mail window keeps one page per server it holds, each on that
// server's own partition, and shows one of them. Showing another server swaps the visible page: no window is closed,
// nothing reloads, and every page keeps its sign-in, scroll and filters. A page not shown is hidden, so its own
// polling pauses (app/lib/window-activity.ts reads document.hidden).
// Pure apart from what is passed in: main.cjs gives `attach` and `detach` (the window's contentView) and the views;
// tests pass fakes.

/**
 * attach(view) puts a page in the window, detach(view) takes it out; close(view) ends its renderer.
 * A view is anything with setVisible(bool) and webContents.
 */
function createMailViews({ attach, detach, close }) {
  const pages = new Map();
  let shown = null;
  const entry = (origin) => pages.get(origin) || null;
  return {
    /** The page of a server, or null. */
    get: (origin) => entry(origin)?.view ?? null,
    /** The server shown and its page, or null. */
    current: () => (shown && pages.has(shown) ? { origin: shown, view: pages.get(shown).view, partition: pages.get(shown).partition } : null),
    origins: () => [...pages.keys()],
    /** The server whose page sends this, or null (a page of a server the window does not hold). */
    originOf(contents) {
      for (const [origin, p] of pages) if (p.view.webContents === contents) return origin;
      return null;
    },
    /** Adds a server's page, hidden until shown; one page per server. */
    add(origin, view, partition = null) {
      if (pages.has(origin)) throw new Error('This server already has a page in the window');
      pages.set(origin, { view, partition });
      view.setVisible(false);
      attach(view);
      return view;
    },
    /** Shows one server's page and hides the others; false when the window holds no page for it. */
    show(origin) {
      const target = entry(origin);
      if (!target) return false;
      for (const [o, p] of pages) if (o !== origin) p.view.setVisible(false);
      target.view.setVisible(true);
      shown = origin;
      return true;
    },
    /** Takes a server's page out of the window and ends it (a forgotten server, a page that failed). */
    drop(origin) {
      const p = entry(origin);
      if (!p) return false;
      pages.delete(origin);
      if (shown === origin) shown = null;
      try { detach(p.view); } catch { /* the window is already gone */ }
      try { close(p.view); } catch { /* its renderer is already gone */ }
      return true;
    },
    /** Every page on this partition, dropped (its storage is about to be retired). */
    dropPartition(partition) {
      let dropped = 0;
      for (const [origin, p] of [...pages]) if (p.partition === partition && this.drop(origin)) dropped++;
      return dropped;
    },
    /** Every page dropped (the window closed). */
    clear() { for (const origin of [...pages.keys()]) this.drop(origin); },
    /** Calls fn(view, origin) for every page, shown or not. */
    each(fn) { for (const [origin, p] of pages) fn(p.view, origin); },
  };
}

module.exports = { createMailViews };
