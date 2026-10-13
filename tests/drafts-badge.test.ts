// UI walk 2026-10-13: the Drafts badge counted only this device's drafts until the Drafts dialog was
// opened once, so drafts an agent made (B-09) or another device saved stayed invisible. The server's
// drafts are read once when the inbox opens (fresh for five minutes, no polling) and again whenever
// the dialog opens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync("app/routes/unified-inbox.tsx", "utf8");
const query = src.slice(src.indexOf("const serverDrafts = useQuery({"), src.indexOf("});", src.indexOf("const serverDrafts = useQuery({")));

test("the server's drafts are read without opening the Drafts dialog, so the badge counts them", () => {
  assert.match(query, /enabled: accounts\.length > 0,/);
  assert.doesNotMatch(query, /enabled: draftsOpen/);
});

test("opening the dialog reads them fresh; otherwise they stay five minutes, with no polling", () => {
  assert.match(query, /staleTime: draftsOpen \? 0 : 5 \* 60_000,/);
  assert.doesNotMatch(query, /refetchInterval/);
  assert.match(src, /useEffect\(\(\) => \{ if \(draftsOpen && accounts\.length > 0\) void serverDrafts\.refetch\(\); \}, \[draftsOpen\]\)/, "opening the dialog reads them again");
});
