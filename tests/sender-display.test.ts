import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cleanSenderName, displaySender, nameFromHeaders } from "../shared/mail/sender";

/**
 * UI walk 2026-10-08: Cloudflare mail showed every sender as a bare address ("jordan@client.test")
 * because only the address was stored. The name now travels beside it (sender_name) and older rows
 * read it from their stored From header.
 */
const headers = (from: string) => JSON.stringify([{ key: "from", value: from }, { key: "subject", value: "x" }]);

test("a stored name is shown beside the address, in the form Gmail rows use", () => {
  assert.equal(displaySender("jordan@client.test", "Jordan Lee"), "Jordan Lee <jordan@client.test>");
  assert.equal(displaySender("chen@studio.test", "Chen, Maya"), "\"Chen, Maya\" <chen@studio.test>", "a comma would split the header: quoted");
  assert.equal(displaySender("a@b.test", null), "a@b.test");
  assert.equal(displaySender("a@b.test", "  "), "a@b.test");
  assert.equal(displaySender("a@b.test", "a@b.test"), "a@b.test", "a name that is the address adds nothing");
  assert.equal(displaySender("", "Someone"), "");
});

test("older rows read the name from their stored From header, when it names the same address", () => {
  assert.equal(nameFromHeaders("maya@studio.test", headers("Maya Chen <maya@studio.test>")), "Maya Chen");
  assert.equal(nameFromHeaders("maya@studio.test", headers("\"Maya Chen\" <MAYA@studio.test>")), "Maya Chen");
  assert.equal(nameFromHeaders("maya@studio.test", headers("Someone <other@studio.test>")), null, "another address's name is not borrowed");
  assert.equal(nameFromHeaders("maya@studio.test", headers("maya@studio.test")), null);
  assert.equal(nameFromHeaders("maya@studio.test", "not json"), null);
  assert.equal(nameFromHeaders("maya@studio.test", null), null);
  assert.equal(displaySender("maya@studio.test", null, headers("Maya Chen <maya@studio.test>")), "Maya Chen <maya@studio.test>");
});

test("encoded UTF-8 names are decoded; anything undecodable stays as written", () => {
  const b = `=?UTF-8?B?${Buffer.from("Иван Петров").toString("base64")}?=`;
  assert.equal(nameFromHeaders("ivan@ru.test", headers(`${b} <ivan@ru.test>`)), "Иван Петров");
  assert.equal(nameFromHeaders("ana@shop.test", headers("=?utf-8?Q?Ana_L=C3=B3pez?= <ana@shop.test>")), "Ana López");
  assert.equal(nameFromHeaders("x@y.test", headers("=?UTF-8?B?!!!?= <x@y.test>")), "=?UTF-8?B?!!!?=");
});

test("a name is cleaned before it is shown or put back in a header", () => {
  assert.equal(cleanSenderName("Evil <x@y> \"name\"\r\nBcc: z"), "Evil x@y name Bcc: z");
  assert.equal(cleanSenderName("x".repeat(300))?.length, 120);
  assert.equal(cleanSenderName(undefined), null);
});

test("the server keeps the name on receipt and shows it in the feed; the reader shows it too", () => {
  assert.match(readFileSync("workers/index.ts", "utf8"), /sender_name: cleanSenderName\(parsedEmail\.from\?\.name\)/);
  assert.match(readFileSync("workers/durableObject/migrations.ts", "utf8"), /"19_sender_name"[\s\S]*ADD COLUMN sender_name TEXT/);
  assert.match(readFileSync("workers/lib/inbox-query.ts", "utf8"), /sender: displaySender\(row\.sender, row\.sender_name, row\.raw_headers\)/);
  assert.match(readFileSync("app/components/inbox/model.ts", "utf8"), /from: displaySender\(m\.sender, m\.sender_name, m\.raw_headers\)/);
});

test("search finds Cyrillic in any case: SQLite folds ASCII only, so other letters are matched in their case forms", async () => {
  const { searchVariants } = await import("../workers/lib/inbox-query");
  assert.deepEqual(searchVariants("order"), [], "an ASCII query keeps the single folded match");
  assert.deepEqual(searchVariants("привет"), ["привет", "Привет", "ПРИВЕТ"]);
  assert.deepEqual(searchVariants("ПРИВЕТ"), ["привет", "Привет", "ПРИВЕТ"]);
  assert.deepEqual(searchVariants("Ana López"), ["ana lópez", "Ana lópez", "ANA LÓPEZ"]);
});
