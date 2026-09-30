// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import DOMPurify from "dompurify";
import { mailImagePolicy, type InlineAttachments } from "~/lib/mail-image-policy";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Every link in a message opens a new window with no opener. A message can no
 * longer navigate the app's own tab (a target="_top" link used to replace the
 * inbox with any page, e.g. a fake sign-in).
 */
export function sanitizeMailHtml(html: string): string {
	installLinkHook();
	// <style> stays: the frame is sandboxed without same-origin, its CSP limits
	// images to the allowed set, and newsletters fall apart without their CSS.
	return DOMPurify.sanitize(html, {
		USE_PROFILES: { html: true },
		ADD_TAGS: ["style"],
		FORCE_BODY: true,
	});
}
let linkHookInstalled = false;
function installLinkHook() {
	if (linkHookInstalled || typeof DOMPurify.addHook !== "function") return;
	linkHookInstalled = true;
	DOMPurify.addHook("afterSanitizeAttributes", (node) => {
		if (node.tagName === "A" || node.tagName === "AREA") {
			node.setAttribute("target", "_blank");
			node.setAttribute("rel", "noopener noreferrer");
		}
		if (node.tagName === "FORM") node.removeAttribute("action");
	});
}

interface EmailIframeProps {
	body: string;
	/** Account-scoped identity resets remote-image permission on another message. */
	messageKey?: string;
	inlineAttachments?: InlineAttachments;
	/** When true, iframe auto-sizes to content height instead of filling parent */
	autoSize?: boolean;
}

/**
 * Renders email HTML inside a sandboxed iframe.
 *
 * Security model:
 * - DOMPurify sanitises the HTML before injection.
 * - The iframe sandbox does NOT include `allow-same-origin`, so even if
 *   DOMPurify has a bypass the attacker's code runs in an opaque origin
 *   with no access to the parent page's cookies, DOM, or API.
 * - Because the iframe is cross-origin we cannot read `contentDocument`
 *   for auto-sizing. Instead, the injected HTML includes a tiny inline
 *   script that posts its body height to the parent via `postMessage`.
 *   The `allow-scripts` flag is required for this, but scripts inside
 *   the opaque-origin sandbox cannot access anything useful.
 * - A strict CSP meta tag blocks external resource loads inside the
 *   iframe as a defense-in-depth layer.
 */
export default function EmailIframe({ body, messageKey, inlineAttachments, autoSize }: EmailIframeProps) {
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = useState(autoSize ? 100 : 0);
	const [allowedMessage, setAllowedMessage] = useState<string | null>(null);
	const identity = JSON.stringify([messageKey ?? "", body]);
	const remoteImages = allowedMessage === identity;
	const inlineKey = JSON.stringify(inlineAttachments ?? null);

	// Listen for height reports from the sandboxed iframe
	const handleMessage = useCallback(
		(event: MessageEvent) => {
			if (!autoSize) return;
			// Only accept messages from our own iframe
			if (event.source !== iframeRef.current?.contentWindow) return;
			if (
				event.data &&
				typeof event.data === "object" &&
				event.data.__emailIframeHeight &&
				typeof event.data.height === "number" &&
				Number.isFinite(event.data.height) &&
				event.data.height > 0
			) {
				setHeight(Math.min(event.data.height, 30000));
			}
		},
		[autoSize],
	);

	useEffect(() => {
		window.addEventListener("message", handleMessage);
		return () => window.removeEventListener("message", handleMessage);
	}, [handleMessage]);

	useEffect(() => {
		const iframe = iframeRef.current;
		if (!iframe) return;

		const cleanBody = sanitizeMailHtml(body);

		const padding = autoSize ? "0" : "24px";

		// Height-reporting script: sends body.scrollHeight to the parent.
		// Runs inside the opaque-origin sandbox so it has zero access to
		// the parent page — it can only postMessage.
		const heightScript = autoSize
			? `<script>
				var last = 0;
				function reportHeight() {
					var h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
					if (h > 0 && h !== last) { last = h; parent.postMessage({ __emailIframeHeight: true, height: h }, "*"); }
				}
				reportHeight();
				// Images and fonts arrive late (especially after "Load external
				// images"); follow every size change instead of a few early samples.
				if (typeof ResizeObserver === "function") new ResizeObserver(reportHeight).observe(document.body);
				window.addEventListener("load", reportHeight);
				setTimeout(reportHeight, 400);
			<\/script>`
			: "";

		// Use srcdoc so the iframe is truly sandboxed (no same-origin access).
		// We can't use doc.write() because that requires allow-same-origin.
		iframe.srcdoc = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${mailImagePolicy(remoteImages, window.location.origin, JSON.parse(inlineKey) ?? undefined)}">
<style>
* { box-sizing: border-box; }
html {
	background: #ffffff;
	color-scheme: light;
}
body {
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
	font-size: 14px;
	line-height: 1.6;
	color: #1a1a1a;
	background: #ffffff;
	padding: ${padding};
	margin: 0;
	word-wrap: break-word;
	overflow-wrap: break-word;
	${autoSize ? "overflow: hidden;" : ""}
}
[style*="position: fixed"], [style*="position:fixed"], [style*="position: absolute"], [style*="position:absolute"] {
	position: relative !important;
}
a { color: #2563eb; }
img { max-width: 100%; height: auto; }
blockquote {
	border-left: 3px solid #d1d5db;
	padding-left: 1em;
	margin-left: 0;
	color: #6b7280;
}
pre {
	background: #f3f4f6;
	padding: 12px;
	border-radius: 6px;
	overflow-x: auto;
	font-size: 13px;
}
table { border-collapse: collapse; max-width: 100%; }
td, th { padding: 4px 8px; }
p { margin: 4px 0; }
h1, h2, h3 { margin: 8px 0 4px; }
ul, ol { padding-left: 20px; margin: 4px 0; }
</style>
</head>
<body>${cleanBody}${heightScript}</body>
</html>`;
	}, [body, autoSize, remoteImages, inlineKey]);

	return (
		<div className={autoSize ? "" : "flex h-full min-h-0 flex-col"}>
			<div className="flex flex-wrap items-center justify-between gap-2 border-b border-kumo-line p-3 text-sm text-kumo-subtle">
				<span>{remoteImages ? "External images enabled for this message." : "External images are blocked to protect your privacy."}</span>
				<button type="button" className="rounded px-2 py-1 font-medium text-kumo-default underline focus-visible:outline focus-visible:outline-2" onClick={() => setAllowedMessage(remoteImages ? null : identity)}>
					{remoteImages ? "Block external images" : "Load external images"}
				</button>
			</div>
		<iframe
			ref={iframeRef}
			className="block w-full border-0"
			style={autoSize ? { height: `${height}px` } : { height: "100%" }}
			sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
			title="Email content"
			referrerPolicy="no-referrer"
		/>
		</div>
	);
}
