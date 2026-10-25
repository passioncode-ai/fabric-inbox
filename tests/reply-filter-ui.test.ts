import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * B-170 (SCN-079): the reply filter offers Abandoned with its number beside Needs a reply, and a state
 * the agent left alone on purpose reads as No reply needed, not as a message waiting for someone.
 */
(globalThis as { React?: unknown }).React = React;
const APP = pathToFileURL(`${process.cwd()}/app/`).href;
registerHooks({
  resolve(specifier, context, next) {
    return specifier.startsWith("~/") ? next(new URL(specifier.slice(2), APP).href, context) : next(specifier, context);
  },
});
const { I18nProvider } = await import("../app/lib/i18n");
const { default: ReplyFilter } = await import("../app/components/inbox/ReplyFilter");
const { replyStateLabel, replyStateOpen } = await import("../app/components/inbox/reply-state");
const { createT } = await import("../shared/i18n");

const render = (locale: "en" | "ru", props: Parameters<typeof ReplyFilter>[0]) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale, choice: locale }, createElement(ReplyFilter, props)));

test("B-170: Abandoned sits beside Needs a reply with its own number and toggles the filter", () => {
  const counts = { unanswered: 3, needs_data: 2, no_reply_needed: 9, abandoned: 4 };
  const off = render("en", { value: "", counts, onChange: () => {} });
  assert.match(off, /Needs a reply<span>5<\/span>/, "No reply needed is not counted as waiting");
  assert.match(off, /aria-pressed="false"[^>]*>Abandoned<span>4<\/span>/);
  const on = render("ru", { value: "abandoned", counts, onChange: () => {} });
  assert.match(on, /aria-pressed="true"[^>]*>Брошено<span>4<\/span>/);
  assert.doesNotMatch(on, /<select/, "the one-status menu belongs to Needs a reply");
  assert.match(render("en", { value: "open", counts, onChange: () => {} }), /No reply needed \(9\)/);
});

test("B-170: No reply needed reads quietly in both languages", () => {
  assert.equal(replyStateLabel("no_reply_needed", createT("en")), "No reply needed");
  assert.equal(replyStateLabel("no_reply_needed", createT("ru")), "Ответ не нужен");
  assert.equal(replyStateOpen("no_reply_needed"), false);
});
