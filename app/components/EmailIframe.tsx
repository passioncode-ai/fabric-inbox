// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import DOMPurify from "dompurify";
import { isBlockedLink } from "../../shared/mail/blocked-links";
import { mailImagePolicy, type InlineAttachments } from "~/lib/mail-image-policy";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { hasRemoteContent } from "../lib/mail-content";
import { useT } from "../lib/i18n";
import { acceptFrameSelection, FRAME_SELECTION_SCRIPT, type QuoteRect } from "../lib/quote-selection";
import { acceptFrameLink, frameLinkScript, guardContext, guardHref, hostParts, type LinkGuardContext } from "../lib/link-guard";
import { linkDecision, type CheckedLink, type LinkVerdict, type ReaderLink, type SafetyColour } from "../../shared/mail/safety";

/**
 * S08 (B-273): what a message frame tells the reader about the text selected in it. `rect` is the selection's
 * end in the app window's coordinates; `selection` null means it cleared; `reload` that the frame's content was
 * replaced (or the frame left), so a selection held from it is gone.
 */
export type FrameSelectionReport = { key: string; selection: { text: string; rect: QuoteRect | null } | null; reload?: boolean };
/** Given by a reader that quotes selections (the unified inbox); frames elsewhere report to nobody. */
export const QuoteSelectionContext = createContext<((report: FrameSelectionReport) => void) | null>(null);

/**
 * Every link in a message opens a new window with no opener. A message can no
 * longer navigate the app's own tab (a target="_top" link used to replace the
 * inbox with any page, e.g. a fake sign-in).
 */
/**
 * B-180: links to hosts the server's Okolos feed lists do not open from the message: they lose their address and keep
 * their text, struck through, with why in their title. `blocked` holds the hosts while one sanitize runs (it is synchronous).
 */
let blocked: { hosts: string[]; title: string } | null = null;
const blockedHost = (href: string | null) => !!blocked && isBlockedLink(href, blocked.hosts);
/** S04 (B-270): while one guarded sanitize runs, its context and the links it took the address from. */
let guarded: { ctx: LinkGuardContext; links: ReaderLink[] } | null = null;

export function sanitizeMailHtml(html: string, block?: { hosts: string[]; title: string }): string {
	installLinkHook();
	blocked = block?.hosts.length ? { hosts: block.hosts.map((h) => h.toLowerCase()), title: block.title } : null;
	try {
		return sanitizeNow(html);
	} finally {
		blocked = null;
	}
}

/**
 * S04 (B-270): the sanitize every message frame uses. A link the safety check cannot vouch for loses its address and
 * keeps `data-okolos-link`, its index in `links`, which the reader resolves and decides (`linkDecision`).
 */
export function sanitizeGuarded(html: string, ctx: LinkGuardContext, block?: { hosts: string[]; title: string }): { html: string; links: ReaderLink[] } {
	installLinkHook();
	blocked = block?.hosts.length ? { hosts: block.hosts.map((h) => h.toLowerCase()), title: block.title } : null;
	guarded = { ctx, links: [] };
	try {
		const out = sanitizeNow(html);
		return { html: out, links: guarded.links };
	} finally {
		blocked = null;
		guarded = null;
	}
}
function sanitizeNow(html: string): string {
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
		// S04: the index is ours alone; a message's own data-okolos-link is dropped.
		if (typeof node.removeAttribute === "function") node.removeAttribute("data-okolos-link");
		const tag = (node.nodeName || "").toUpperCase();
		if (tag === "A" || tag === "AREA") {
			if (blockedHost(node.getAttribute("href"))) {
				node.removeAttribute("href");
				node.setAttribute("title", blocked!.title);
				node.setAttribute("style", "text-decoration: line-through; cursor: not-allowed");
				return;
			}
			const raw = node.getAttribute("href") ?? node.getAttribute("xlink:href");
			if (guarded && raw !== null) {
				const { keep, link } = guardHref(raw, node.textContent ?? "", guarded.links.length, guarded.ctx);
				if (!keep) {
					node.removeAttribute("href");
					node.removeAttribute("xlink:href");
					node.setAttribute("data-okolos-link", String(link.index));
					node.setAttribute("role", "link");
					node.setAttribute("tabindex", "0");
					node.setAttribute("style", `${node.getAttribute("style") ?? ""};cursor:pointer`);
					guarded.links.push(link);
					return;
				}
			}
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
	/** B-180: hosts of known phishing sites this message links to; their links do not open. */
	blockedHosts?: string[];
	/**
	 * S04 (B-270): the message's safety colour and the links the server checked. Absent (no record, a view with none,
	 * a record that cannot be read): grey, and every link asks before it opens.
	 */
	linkSafety?: { colour: SafetyColour; links: CheckedLink[] } | null;
}

/** "Open anyway", remembered for that link of that message until the window closes (S04). */
const openedAnyway = new Set<string>();

function openUrl(url: string) {
	window.open(url, "_blank", "noopener,noreferrer");
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
 * - S08: every frame also runs the selection script (`FRAME_SELECTION_SCRIPT`), which posts the
 *   visible text a person selects so Reply can quote it. The parent accepts it only from this frame,
 *   with user activation, re-checked (`acceptFrameSelection`).
 */
export default function EmailIframe({ body, messageKey, inlineAttachments, autoSize, blockedHosts, linkSafety }: EmailIframeProps) {
	const t = useT();
	const iframeRef = useRef<HTMLIFrameElement>(null);
	// S04: this render's guarded links and nonce, and the notice a guarded link raised.
	const renderRef = useRef<{ nonce: string; links: ReaderLink[] }>({ nonce: "", links: [] });
	const [notice, setNotice] = useState<{ link: ReaderLink; verdict: LinkVerdict } | null>(null);
	const noticeRef = useRef<HTMLDivElement>(null);
	const colourRef = useRef(linkSafety?.colour);
	colourRef.current = linkSafety?.colour;
	const safetyKey = JSON.stringify(linkSafety ?? null);
	const [height, setHeight] = useState(autoSize ? 100 : 0);
	const [allowedMessage, setAllowedMessage] = useState<string | null>(null);
	const identity = JSON.stringify([messageKey ?? "", body]);
	const remoteImages = allowedMessage === identity;
	const inlineKey = JSON.stringify(inlineAttachments ?? null);

	const report = useContext(QuoteSelectionContext);
	const reportRef = useRef(report);
	reportRef.current = report;
	const keyRef = useRef(messageKey ?? "");
	keyRef.current = messageKey ?? "";

	// Height reports (autoSize) and selections (S08) from the sandboxed iframe
	const handleMessage = useCallback(
		(event: MessageEvent) => {
			const frame = iframeRef.current;
			// Only accept messages from our own iframe
			if (!frame?.contentWindow || event.source !== frame.contentWindow) return;
			if (
				event.data &&
				typeof event.data === "object" &&
				event.data.__emailIframeHeight
			) {
				if (
					autoSize &&
					typeof event.data.height === "number" &&
					Number.isFinite(event.data.height) &&
					event.data.height > 0
				) setHeight(Math.min(event.data.height, 30000));
				return;
			}
			const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
			// S04: a guarded link, by its index in this render's list; decided again at every activation (KIMI-47).
			const index = acceptFrameLink(event, frame.contentWindow, renderRef.current.nonce, renderRef.current.links.length, activation);
			if (index !== undefined) {
				const link = renderRef.current.links[index]!;
				const verdict = linkDecision(colourRef.current ?? { colour: "grey", label: "notChecked", linksComplete: false }, link);
				if (verdict.action === "open") openUrl(verdict.url);
				else if (verdict.action === "ask" && openedAnyway.has(`${keyRef.current}|${verdict.url}`)) openUrl(verdict.url);
				else setNotice({ link, verdict });
				return;
			}
			if (!reportRef.current) return;
			const selection = acceptFrameSelection(event, frame.contentWindow, activation);
			if (selection === undefined) return;
			if (!selection) {
				reportRef.current({ key: keyRef.current, selection: null });
				return;
			}
			const box = frame.getBoundingClientRect();
			const rect = selection.rect && {
				left: box.left + selection.rect.left,
				top: box.top + selection.rect.top,
				right: box.left + selection.rect.right,
				bottom: box.top + selection.rect.bottom,
			};
			reportRef.current({ key: keyRef.current, selection: { text: selection.text, rect } });
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

		const safety = JSON.parse(safetyKey) as EmailIframeProps["linkSafety"];
		const guardedBody = sanitizeGuarded(body, guardContext(safety?.colour, safety?.links),
			blockedHosts?.length ? { hosts: blockedHosts, title: t("Blocked: a known phishing site") } : undefined);
		const cleanBody = guardedBody.html;
		const nonce = crypto.randomUUID();
		renderRef.current = { nonce, links: guardedBody.links };
		setNotice(null);

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
		// S08: every frame reports what is selected in it, so Reply can quote it.
		const selectionScript = `<script>${FRAME_SELECTION_SCRIPT}<\/script>`;
		// S04: every frame reports an activated guarded link as its index and this render's nonce; it runs from the head.
		const linkScript = `<script>${frameLinkScript(nonce)}<\/script>`;

		// Use srcdoc so the iframe is truly sandboxed (no same-origin access).
		// We can't use doc.write() because that requires allow-same-origin.
		iframe.srcdoc = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${mailImagePolicy(remoteImages, window.location.origin, JSON.parse(inlineKey) ?? undefined)}">
${linkScript}
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
<body>${cleanBody}${selectionScript}${heightScript}</body>
</html>`;
		// The frame's content was replaced: a selection held from it is gone (SEC-14).
		const key = keyRef.current;
		reportRef.current?.({ key, selection: null, reload: true });
		return () => reportRef.current?.({ key, selection: null, reload: true });
	}, [body, autoSize, remoteImages, inlineKey, (blockedHosts ?? []).join(","), safetyKey]);

	useEffect(() => { if (notice) noticeRef.current?.focus(); }, [notice]);
	const closeNotice = () => { setNotice(null); iframeRef.current?.focus(); };

	return (
		<div className={autoSize ? "" : "flex h-full min-h-0 flex-col"}>
			{(remoteImages || hasRemoteContent(body)) && <div className="flex flex-wrap items-center justify-between gap-2 border-b border-kumo-line p-3 text-sm text-kumo-subtle">
				<span>{remoteImages ? t("External images enabled for this message.") : t("External images are blocked to protect your privacy.")}</span>
				<button type="button" className="rounded px-2 py-1 font-medium text-kumo-default underline focus-visible:outline focus-visible:outline-2" onClick={() => setAllowedMessage(remoteImages ? null : identity)}>
					{remoteImages ? t("Block external images") : t("Load external images")}
				</button>
			</div>}
			{notice && <LinkNotice notice={notice} refEl={noticeRef} onClose={closeNotice} onOpenAnyway={(url) => {
				openedAnyway.add(`${keyRef.current}|${url}`);
				openUrl(url);
				closeNotice();
			}} />}
		<iframe
			ref={iframeRef}
			className="block w-full border-0"
			style={autoSize ? { height: `${height}px` } : { height: "100%" }}
			sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
			title={t("Email content")}
			referrerPolicy="no-referrer"
		/>
		</div>
	);
}

/**
 * S04: the notice a guarded link raises, an inline alert above the message frame. Escape is "Don't open"; focus moves
 * to it and returns to the frame after.
 */
function LinkNotice({ notice, refEl, onClose, onOpenAnyway }: {
	notice: { link: ReaderLink; verdict: LinkVerdict };
	refEl: React.RefObject<HTMLDivElement | null>;
	onClose: () => void;
	onOpenAnyway: (url: string) => void;
}) {
	const t = useT();
	const [copied, setCopied] = useState(false);
	const { link, verdict } = notice;
	const parts = hostParts(verdict.url);
	const host = parts ? (parts.sub ? `${parts.sub}.${parts.registrable}` : parts.registrable) : "";
	const why = verdict.action === "block"
		? verdict.why === "phishing" ? t("This site is on the phishing list.")
			: verdict.why === "lookalike" ? t("This address imitates {resembles}.", { resembles: link.checked?.resembles ?? "" })
			: verdict.why === "dangerous" ? t("The safety check found this message dangerous, so its links do not open.")
			: t("This link cannot be opened safely.")
		: verdict.action === "ask"
			? verdict.why === "textMismatch" ? t("The text of the link says {shown}, but it goes to {host}.", { shown: link.checked?.shown ?? "", host })
				: verdict.why === "suspicious" ? t("This message looks suspicious, so its links ask first.")
				: verdict.why === "odd" ? t("This link is written in an unusual way, so it asks first.")
				: t("This message was not fully checked, so its links ask first.")
			: "";
	return (
		<div ref={refEl} role="alert" tabIndex={-1} className={"fi-link-notice" + (verdict.action === "block" ? " is-red" : "")}
			onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } }}>
			<p className="fi-link-notice-title">
				{parts ? <>{t("This link goes to {host}", { host: "" }).trim()} <span className="fi-link-host">{parts.sub ? `${parts.sub}.` : ""}<strong>{parts.registrable}</strong></span></>
					: t("This link cannot be opened safely.")}
			</p>
			{why && <p>{why}</p>}
			<div className="fi-link-notice-actions">
				<button type="button" className="fi-secondary" autoFocus={verdict.action === "ask"} onClick={onClose}>{t("Don't open")}</button>
				{verdict.action === "ask" && <button type="button" className="fi-secondary" onClick={() => onOpenAnyway(verdict.url)}>{t("Open anyway")}</button>}
				{verdict.action === "block" && verdict.url && (
					<button type="button" className="fi-secondary" onClick={() => {
						void navigator.clipboard?.writeText(verdict.url!).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {});
					}}>
						{t("Copy address")}{copied && <span role="status" className="fi-copied"> {t("Copied")}</span>}
					</button>
				)}
			</div>
		</div>
	);
}
