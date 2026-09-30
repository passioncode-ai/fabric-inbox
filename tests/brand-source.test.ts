import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
test("web and native shell vendor exact canonical Fabric brand assets", () => {
  const source = JSON.parse(
    readFileSync(
      new URL("../docs/desktop-mail/brand-source.json", import.meta.url),
      "utf8",
    ),
  );
  for (const file of source.files)
    for (const copy of file.copies)
      assert.equal(
        createHash("sha256")
          .update(readFileSync(new URL("../" + copy, import.meta.url)))
          .digest("hex"),
        file.sha256,
        copy,
      );
});
