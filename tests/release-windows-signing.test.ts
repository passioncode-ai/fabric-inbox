// Platform sweep 2026-10-12 (B-100, B-105): Windows signing listed only the app folder's top level,
// so node-pty's binaries in app.asar.unpacked (pty.node, conpty.node, winpty.dll, winpty-agent.exe)
// shipped unsigned while the verify step, also top-level only, said every file was Valid; and the
// post-publish Windows update check ran without the release environment, so SIGNING was false.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const wf = readFileSync(".github/workflows/release.yml", "utf8");

test("B-100: every PE file of the app, nested ones included, is listed for signing", () => {
  const step = wf.slice(wf.indexOf("- name: The app's files that carry no signature"), wf.indexOf("- name: Sign the app's executables and DLLs"));
  assert.match(step, /Get-ChildItem -LiteralPath \$env:APP -File -Recurse/);
  assert.match(step, /'\.exe', '\.dll', '\.node'/);
  assert.match(step, /pty\.node/, "the console's pty.node must be among the files");
});

test("B-100: the verify step checks the same recursive set, not the top level only", () => {
  const verify = wf.slice(wf.indexOf("- name: Every executable and DLL of the app is Valid and timestamped"), wf.indexOf("# Pass 2: electron-builder signs"));
  assert.match(verify, /files: \$\{\{ steps\.allpe\.outputs\.files \}\}/);
  assert.doesNotMatch(verify, /\\\*\.exe/);
  const list = wf.slice(wf.indexOf("- name: Every PE file of the app"), wf.indexOf("- name: Every executable and DLL of the app is Valid"));
  assert.match(list, /id: allpe/);
  assert.match(list, /-Recurse/);
});

test("B-105: the post-publish platform update check runs in the release environment, so a signed release demands Authenticode", () => {
  const start = wf.indexOf("\n  update-check-platforms:\n");
  const body = wf.slice(start, start + 900);
  assert.match(body, /\n    environment: release\n/);
});

test("B-190: the PowerShell Gallery is registered when a Windows runner lacks it, before either signing pass", () => {
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");
  const gallery = workflow.indexOf("- name: The PowerShell Gallery the signing module installs from");
  assert.ok(gallery > 0, "the step exists");
  assert.ok(gallery < workflow.indexOf("- name: Sign the app's executables and DLLs"), "before pass 1");
  assert.ok(gallery < workflow.indexOf("- name: Azure sign-in for electron-builder"), "before pass 2");
  const step = workflow.slice(gallery, workflow.indexOf("# Pass 1", gallery));
  assert.match(step, /if: env\.SIGNING == 'true'/);
  assert.match(step, /Get-PSRepository -Name PSGallery -ErrorAction SilentlyContinue\) \{ Write-Host 'PSGallery: present'; exit 0 \}/, "a runner that has it is left alone");
  assert.match(step, /Register-PSRepository -Default/);
});
