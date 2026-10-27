import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * O-11 (B-184, SCN-030): updating a server that already exists keeps its sign-in as it is
 * (desktop/cloudflare-deploy.cjs step "access"), so the form no longer demands an email it would ignore.
 */
test("O-11: an update hides the email field and does not require it; a server with no sign-in asks again", () => {
  const html = readFileSync("desktop/setup.html", "utf8");
  assert.match(html, /<div id="cf-email-field">\s*<label for="cf-email"/, "the email field can be hidden as one block");
  const js = readFileSync("desktop/setup.js", "utf8");
  assert.match(js, /cfField\('#cf-email-field', !details\?\.existing\);/, "hidden when the account already has a server");
  assert.match(js, /if \(!\$\('#cf-email-field'\)\.hidden && !\/\^/, "the email is only checked while it is asked");
  assert.match(js, /includes\(t\('Enter the email address you will sign in with\.'\)\)\) cfField\('#cf-email-field', true\)/,
    "the field returns when the server turned out to need it");
  const deploy = readFileSync("desktop/cloudflare-deploy.cjs", "utf8");
  assert.match(deploy, /if \(existing\) \{[\s\S]*?return existing\.aud;/, "an existing Access app is kept, so the email is not read");
});
