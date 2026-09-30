import test from "node:test";
import assert from "node:assert/strict";
import { attachmentPath, rewriteInlineImages } from "../app/lib/mail-image-policy";

const url = (id: string) => attachmentPath("box@example.com", "m1", id);
const inline = (id: string, content_id: string) => ({ id, content_id, disposition: "inline" });

test("cid:img1 does not rewrite cid:img10 — each reference ends where its URL ends", () => {
  const html = '<img src="cid:img1"><img src="cid:img10">';
  const out = rewriteInlineImages(html, "box@example.com", "m1", [inline("a1", "img1"), inline("a10", "img10")]);
  assert.equal(out, `<img src="${url("a1")}"><img src="${url("a10")}">`);
});

test("the order of attachments cannot corrupt a longer content id", () => {
  const html = "<img src='cid:img10'> <img src='cid:img1'>";
  const out = rewriteInlineImages(html, "box@example.com", "m1", [inline("a1", "img1")]);
  assert.equal(out, `<img src='cid:img10'> <img src='${url("a1")}'>`);
});

test("references end at quotes, whitespace, parentheses, angle brackets and end of text", () => {
  const out = rewriteInlineImages(
    'a cid:x b <p style="background:url(cid:x)">cid:x</p>cid:x',
    "box@example.com",
    "m1",
    [inline("att", "x")],
  );
  assert.equal(out, `a ${url("att")} b <p style="background:url(${url("att")})">${url("att")}</p>${url("att")}`);
});

test("content ids with @ and dots match literally, case-insensitively", () => {
  const out = rewriteInlineImages('<img src="CID:image001.PNG@01D9.X">', "box@example.com", "m1", [
    inline("p", "<image001.png@01d9.x>"),
  ]);
  assert.equal(out, `<img src="${url("p")}">`);
  const dot = rewriteInlineImages('<img src="cid:aXb">', "box@example.com", "m1", [inline("p", "a.b")]);
  assert.equal(dot, '<img src="cid:aXb">');
});

test("replacement patterns in an attachment id are inserted literally", () => {
  const out = rewriteInlineImages('<img src="cid:x">', "box@example.com", "m1", [inline("$&$'", "x")]);
  assert.equal(out, `<img src="${url("$&$'")}">`);
  assert.ok(!out.includes("cid:x"));
});

test("non-inline parts, empty ids and missing inputs leave the body alone", () => {
  const html = '<img src="cid:x">';
  assert.equal(rewriteInlineImages(html, "b", "m", [{ id: "a", content_id: "x", disposition: "attachment" }]), html);
  assert.equal(rewriteInlineImages(html, "b", "m", [{ id: "a", content_id: "<>", disposition: "inline" }]), html);
  assert.equal(rewriteInlineImages(html, "b", "m", []), html);
  assert.equal(rewriteInlineImages("", "b", "m", [inline("a", "x")]), "");
});
