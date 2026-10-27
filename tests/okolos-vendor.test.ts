import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

/**
 * B-178: the Okolos detectors are copied, never edited here (vendor/okolos/README.md). Each file must match the hash
 * its manifest pins; moving the pin means copying them again from Okolos and writing the new hashes together.
 */
const dir = new URL("../vendor/okolos/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", dir), "utf8")) as { commit: string; files: Record<string, { from: string; sha256: string }> };

test("every vendored Okolos file is byte for byte the pinned one, and nothing unlisted is there", () => {
  for (const [file, pin] of Object.entries(manifest.files))
    assert.equal(createHash("sha256").update(readFileSync(new URL(file, dir))).digest("hex"), pin.sha256, `${file} differs from Okolos ${manifest.commit}:${pin.from}`);
  const present = ["core-injection", "core-feeds", "core-lookalike"].flatMap((d) => readdirSync(new URL(`${d}/`, dir)).map((f) => `${d}/${f}`)).sort();
  assert.deepEqual(present, Object.keys(manifest.files).sort());
});
