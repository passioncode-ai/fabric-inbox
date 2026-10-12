// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useKumoToastManager } from "@cloudflare/kumo";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import api, { type MailFile } from "~/services/api";
import {
	buildQuotedReplyBlock,
	escapeHtml,
	getSignatureBlock,
	htmlToPlainText,
	splitEmailList,
	stripHtml,
	toEmailListValue,
} from "~/lib/utils";
import { useForwardEmail, useInvalidateEmailData, useReplyToEmail, useSaveDraft, useSendEmail } from "~/queries/emails";
import { useMailbox } from "~/queries/mailboxes";
import { useUIStore } from "~/hooks/useUIStore";
import { useT, type T } from "~/lib/i18n";
import { formatQuotedDate } from "shared/dates";

function appendUniqueAddress(
	addresses: string[],
	seen: Set<string>,
	address: string,
	exclude?: string,
) {
	const trimmed = address.trim();
	if (!trimmed) return;

	const normalized = trimmed.toLowerCase();
	if (normalized === exclude || seen.has(normalized)) return;

	seen.add(normalized);
	addresses.push(trimmed);
}

interface ComposeFormFields {
	to: string;
	cc: string;
	bcc: string;
	showCcBcc: boolean;
	subject: string;
	body: string;
}

const EMPTY_FIELDS: ComposeFormFields = {
	to: "",
	cc: "",
	bcc: "",
	showCcBcc: false,
	subject: "",
	body: "",
};

function getPrefixedSubject(subject: string, prefix: "Re" | "Fwd") {
	const expectedPrefix = `${prefix}: `;
	return subject.startsWith(expectedPrefix)
		? subject
		: `${expectedPrefix}${subject}`;
}

function buildForwardBody(
	original: NonNullable<ReturnType<typeof useUIStore.getState>["composeOptions"]["originalEmail"]>,
	sigBlock: string,
	t: T,
) {
	const safeSender = escapeHtml(original.sender);
	const safeSubject = escapeHtml(original.subject);
	const safeBody = escapeHtml(stripHtml(original.body || "")).replace(/\n/g, "<br>");

	return `<p><br></p>${sigBlock ? `${sigBlock}<br>` : ""}<div style="border: 1px solid #ddd; padding: 1em; background-color: #f9f9f9; margin: 1em 0;"><strong>${t("Forwarded message:")}</strong><br><strong>${t("From:")}</strong> ${safeSender}<br><strong>${t("Date:")}</strong> ${formatQuotedDate(original.date, t.locale)}<br><strong>${t("Subject:")}</strong> ${safeSubject}<br><br>${safeBody}</div>`;
}

function buildReplyAllFields(
	original: NonNullable<ReturnType<typeof useUIStore.getState>["composeOptions"]["originalEmail"]>,
	selfAddress?: string,
) {
	const toRecipients: string[] = [];
	const toSeen = new Set<string>();
	appendUniqueAddress(toRecipients, toSeen, original.sender, selfAddress);

	for (const recipient of splitEmailList(original.recipient)) {
		appendUniqueAddress(toRecipients, toSeen, recipient, selfAddress);
	}

	const ccRecipients: string[] = [];
	const ccSeen = new Set<string>();
	for (const recipient of splitEmailList(original.cc)) {
		const normalized = recipient.toLowerCase();
		if (
			normalized === selfAddress ||
			toSeen.has(normalized) ||
			ccSeen.has(normalized)
		) {
			continue;
		}
		ccSeen.add(normalized);
		ccRecipients.push(recipient);
	}

	return {
		to: toRecipients.join(", "),
		cc: ccRecipients.join(", "),
		showCcBcc: ccRecipients.length > 0,
	};
}

function buildInitialComposeFields(
	composeOptions: ReturnType<typeof useUIStore.getState>["composeOptions"],
	mailboxEmail: string | undefined,
	sigBlock: string,
	t: T,
): ComposeFormFields {
	const { draftEmail: draft, originalEmail: original, mode } = composeOptions;

	if (draft) {
		return {
			to: draft.recipient || "",
			cc: draft.cc || "",
			bcc: draft.bcc || "",
			showCcBcc: Boolean(draft.cc || draft.bcc),
			subject: draft.subject || "",
			body: draft.body || "",
		};
	}

	if (!original) {
		return {
			...EMPTY_FIELDS,
			body: sigBlock ? `<p><br></p>${sigBlock}` : "",
		};
	}

	if (mode === "reply") {
		return {
			...EMPTY_FIELDS,
			to: original.sender,
			subject: getPrefixedSubject(original.subject, "Re"),
			body: `<p><br></p>${sigBlock ? `${sigBlock}<br>` : ""}${buildQuotedReplyBlock(original.date, original.sender, original.body || "", t)}`,
		};
	}

	if (mode === "reply-all") {
		const recipients = buildReplyAllFields(original, mailboxEmail?.toLowerCase());
		return {
			...EMPTY_FIELDS,
			...recipients,
			subject: getPrefixedSubject(original.subject, "Re"),
			body: `<p><br></p>${sigBlock ? `${sigBlock}<br>` : ""}${buildQuotedReplyBlock(original.date, original.sender, original.body || "", t)}`,
		};
	}

	if (mode === "forward") {
		return {
			...EMPTY_FIELDS,
			subject: getPrefixedSubject(original.subject, "Fwd"),
			body: buildForwardBody(original, sigBlock, t),
		};
	}

	return {
		...EMPTY_FIELDS,
		body: sigBlock ? `<p><br></p>${sigBlock}` : "",
	};
}

export function useComposeForm(mailboxId?: string, _folder?: string) {
	const t = useT();
	const toastManager = useKumoToastManager();
	const { composeOptions, closePanel, closeCompose } = useUIStore();
	const { data: currentMailbox } = useMailbox(mailboxId);
	const sendEmailMutation = useSendEmail();
	const saveDraftMutation = useSaveDraft();
	const replyMutation = useReplyToEmail();
	const forwardMutation = useForwardEmail();
	const invalidateMail = useInvalidateEmailData();

	const [to, setTo] = useState("");
	const [cc, setCc] = useState("");
	const [bcc, setBcc] = useState("");
	const [showCcBcc, setShowCcBcc] = useState(false);
	const [subject, setSubject] = useState("");
	const [body, setBody] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [isSavingDraft, setIsSavingDraft] = useState(false);
	const [isSending, setIsSending] = useState(false);
	const sendKey = useRef<string>(crypto.randomUUID());
	const sendingRef = useRef(false);
	const lastInitializedOptionsRef = useRef<typeof composeOptions | null>(null);
	const isDraftEdit = !!composeOptions.draftEmail;
	// B-88: one draft id for the whole compose (the draft's own when editing one), saved in place so
	// its files stay; a forward carries the original's files, read once.
	const draftKey = useRef<string>(composeOptions.draftEmail?.id ?? crypto.randomUUID());
	const draftSaved = useRef(!!composeOptions.draftEmail);
	const forwardFiles = useRef<Promise<MailFile[]> | null>(null);

	const formTitle = useMemo(() => {
		if (isDraftEdit) return t("Edit Draft");
		switch (composeOptions.mode) { case "reply": return t("[mode] Reply"); case "reply-all": return t("[mode] Reply All"); case "forward": return t("[mode] Forward"); default: return t("New Message"); }
	}, [composeOptions.mode, isDraftEdit, t]);

	const sigBlock = useMemo(() => getSignatureBlock(currentMailbox?.settings), [currentMailbox]);

	useEffect(() => {
		if (lastInitializedOptionsRef.current === composeOptions) return;
		lastInitializedOptionsRef.current = composeOptions;
		sendKey.current = crypto.randomUUID();
		draftKey.current = composeOptions.draftEmail?.id ?? crypto.randomUUID();
		draftSaved.current = !!composeOptions.draftEmail;
		forwardFiles.current = null;

		const initialFields = buildInitialComposeFields(
			composeOptions,
			currentMailbox?.email,
			sigBlock,
			t,
		);
		setError(null);
		setTo(initialFields.to);
		setCc(initialFields.cc);
		setBcc(initialFields.bcc);
		setShowCcBcc(initialFields.showCcBcc);
		setSubject(initialFields.subject);
		setBody(initialFields.body);
	}, [composeOptions, currentMailbox?.email, sigBlock, t]);

	/** The original's files for a forward (a forward used to go without them, B-88). */
	const originalFiles = (): Promise<MailFile[]> => {
		const original = composeOptions.originalEmail;
		if (composeOptions.mode !== "forward" || !original || !mailboxId) return Promise.resolve([]);
		forwardFiles.current ??= Promise.all((original.attachments ?? []).map(async (a) => {
			const blob = await api.getAttachment(mailboxId, original.id, a.id);
			const bytes = new Uint8Array(await blob.arrayBuffer());
			let binary = "";
			for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
			return { content: btoa(binary), filename: a.filename, type: a.mimetype, disposition: a.disposition === "inline" ? "inline" as const : "attachment" as const,
				...(a.content_id ? { contentId: a.content_id } : {}) };
		}));
		return forwardFiles.current;
	};
	/** Saves the draft in place under its id; the first save of a forward adds the original's files. */
	const saveInPlace = async () => {
		const first = !draftSaved.current;
		await saveDraftMutation.mutateAsync({ mailboxId: mailboxId!, draft: {
			draft_id: draftKey.current,
			to,
			cc: cc || undefined,
			bcc: bcc || undefined,
			subject,
			body,
			in_reply_to: composeOptions.originalEmail?.id || composeOptions.draftEmail?.in_reply_to || undefined,
			thread_id: composeOptions.originalEmail?.thread_id || composeOptions.draftEmail?.thread_id || undefined,
			...(first && composeOptions.mode === "forward" ? { attachments: await originalFiles() } : {}),
		} });
		draftSaved.current = true;
	};

	const handleSaveDraft = async () => {
		if (!mailboxId || isSending) return; setIsSavingDraft(true); setError(null);
		try {
			await saveInPlace();
			toastManager.add({ title: t("Draft saved!") });
		}
		catch (err: unknown) {
			const message = (err instanceof Error && err.message ? t.text(err.message) : null) || t("Failed to save draft.");
			setError(message);
			toastManager.add({ title: message, variant: "error" });
		}
		finally { setIsSavingDraft(false); }
	};

	const handleSend = async (e: FormEvent, onClose: () => void) => {
		e.preventDefault(); if (sendingRef.current || isSending) return; setError(null);
		if (!currentMailbox || !mailboxId) { setError(t("No mailbox selected.")); return; }
		const toRecipients = splitEmailList(to);
		if (toRecipients.length === 0) { setError(t("Add at least one recipient.")); return; }
		const ccRecipients = splitEmailList(cc); const bccRecipients = splitEmailList(bcc);
		const fromName = currentMailbox.settings?.fromName || currentMailbox.name;
		const from = fromName && fromName !== currentMailbox.email ? { email: currentMailbox.email, name: fromName } : currentMailbox.email;
		const emailData = {
			idempotencyKey: sendKey.current,
			to: toEmailListValue(toRecipients),
			cc: toEmailListValue(ccRecipients),
			bcc: toEmailListValue(bccRecipients),
			from,
			subject,
			html: body,
			text: htmlToPlainText(body),
		};
		const mode = composeOptions.mode; const originalId = composeOptions.originalEmail?.id || composeOptions.draftEmail?.in_reply_to;
		sendingRef.current = true; setIsSending(true); toastManager.add({ title: t("Sending email...") });
		try {
			// A saved draft (opened with Edit draft, or saved in this compose) is saved with what is on
			// screen and sent as it is, with its files; the server removes it once accepted (B-88).
			if (draftSaved.current) {
				await saveInPlace();
				await api.sendDraft(mailboxId, draftKey.current, sendKey.current);
				invalidateMail(mailboxId);
			}
			else if ((mode === "reply" || mode === "reply-all") && originalId) await replyMutation.mutateAsync({ mailboxId, emailId: originalId, email: emailData });
			else if (mode === "forward" && originalId) await forwardMutation.mutateAsync({ mailboxId, emailId: originalId, email: { ...emailData, attachments: await originalFiles() } });
			else await sendEmailMutation.mutateAsync({ mailboxId, email: emailData });
			toastManager.add({ title: t("Accepted by email provider") });
			onClose();
		} catch (err: unknown) { const message = (err instanceof Error && err.message ? t.text(err.message) : null) || t("Failed to send email."); setError(message); toastManager.add({ title: message, variant: "error" }); }
		finally { sendingRef.current = false; setIsSending(false); }
	};

	return { to, setTo, cc, setCc, bcc, setBcc, showCcBcc, setShowCcBcc, subject, setSubject, body, setBody, error, setError, isSavingDraft, isSending, formTitle, handleSaveDraft, handleSend, closeCompose, closePanel };
}
