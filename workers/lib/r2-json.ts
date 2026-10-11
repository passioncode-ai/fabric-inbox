/**
 * The JSON of an R2 object about to be read, changed and written back on its etag. A body that
 * cannot be read throws: the write must not replace what it never saw, and its etag would still
 * match (B-78). A body that is not JSON is null, so a damaged object reads as its normalised
 * default and the next change repairs it.
 */
export async function bodyForUpdate(object: { text(): Promise<string> }): Promise<unknown> {
  const text = await object.text();
  try { return JSON.parse(text); } catch { return null; }
}
