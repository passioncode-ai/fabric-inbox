/**
 * Embedded pictures (B-89): which parts of a message the reader may show in its HTML. A part is
 * shown when its type is a raster picture and the HTML names its Content-ID; SVG stays a download,
 * since it can carry script. The same rule decides what the server's inline route answers.
 */
const PICTURES = new Set(["image/png", "image/jpeg", "image/jpg", "image/pjpeg", "image/gif", "image/webp", "image/bmp", "image/avif", "image/x-icon", "image/vnd.microsoft.icon"]);

/** The type an inline route may answer for a part, or null when the part is not a picture to show. */
export function inlinePictureType(mimeType: string | null | undefined): string | null {
  const type = (mimeType ?? "").split(";")[0].trim().toLowerCase();
  return PICTURES.has(type) ? type : null;
}

/** A Content-ID as the HTML names it: without its angle brackets. */
export const bareContentId = (value: string | null | undefined) => (value ?? "").trim().replace(/^<(.*)>$/, "$1").trim();
