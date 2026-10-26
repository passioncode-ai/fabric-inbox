import { test } from "node:test";
import assert from "node:assert/strict";
import { readFiles, runsCode, readable, type MailFile } from "../workers/safety/files";

// B-179: what a message's files say.
const file = (filename: string, mimetype = "application/octet-stream", size = 1000): MailFile => ({ key: `attachments/m/1/${filename}`, filename, mimetype, size });

test("files that run code are named by their name or type; documents are read, at most three", async () => {
  for (const name of ["invoice.exe", "setup.MSI", "run.ps1", "report.docm", "budget.xlsm", "photo.lnk", "disk.iso", "a.js"]) assert.equal(runsCode(file(name)), true, name);
  assert.equal(runsCode(file("x.bin", "application/x-msdownload")), true);
  for (const name of ["invoice.pdf", "contract.docx", "data.csv", "photo.jpg"]) assert.equal(runsCode(file(name)), false, name);
  assert.equal(readable(file("invoice.pdf")), true);
  assert.equal(readable(file("photo.jpg", "image/jpeg")), false, "a picture is not read here");
  assert.equal(readable(file("huge.pdf", "application/pdf", 20 * 1024 * 1024)), false);
  const asked: string[] = [];
  const found = await readFiles([file("a.pdf"), file("b.docx"), file("c.txt"), file("d.pdf"), file("run.exe")],
    async (key) => new Blob([key]), async (files) => { asked.push(...files.map((f) => f.name)); return files.map((f) => ({ name: f.name, text: f.name === "b.docx" ? "" : `text of ${f.name}` })); });
  assert.deepEqual(asked, ["a.pdf", "b.docx", "c.txt"]);
  assert.deepEqual(found.risky, ["run.exe"]);
  assert.deepEqual(found.unread, ["b.docx"], "a document with no text is said to be unread");
  assert.match(found.text, /\[a\.pdf\]\ntext of a\.pdf/);
});

test("with no reader, or a reader that fails, documents are named as unread, never as clean", async () => {
  assert.deepEqual((await readFiles([file("a.pdf")], async () => new Blob(["x"]), null)).unread, ["a.pdf"]);
  assert.deepEqual((await readFiles([file("a.pdf")], async () => new Blob(["x"]), async () => { throw new Error("down"); })).unread, ["a.pdf"]);
  assert.deepEqual((await readFiles([file("a.pdf")], async () => null, async () => [])).unread, ["a.pdf"], "a file not in storage");
});
