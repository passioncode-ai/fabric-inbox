/**
 * Whether a message asks for anything from the network when shown: an image, background, poster
 * or CSS url() on http(s) or a protocol-relative address. Only then is the blocked-images notice
 * worth a line; a plain-text message has nothing to load.
 */
export function hasRemoteContent(html: string): boolean {
	return /\b(?:src|srcset|background|poster)\s*=\s*["']?\s*(?:https?:)?\/\//i.test(html)
		|| /url\(\s*["']?\s*(?:https?:)?\/\//i.test(html);
}
