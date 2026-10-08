// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Loader, Tooltip } from "@cloudflare/kumo";
import {
	ArrowUpIcon,
	RobotIcon,
	TrashIcon,
	UserIcon,
	EnvelopeSimpleIcon,
	MagnifyingGlassIcon,
	PaperPlaneTiltIcon,
	EyeIcon,
	ArrowBendUpLeftIcon,
	WrenchIcon,
	CheckCircleIcon,
	StopIcon,
	PencilSimpleIcon,
	WarningCircleIcon,
	ArrowClockwiseIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import AgentMarkdown from "~/components/AgentMarkdown";
import { useT } from "../lib/i18n";
import { msg } from "../../shared/i18n";
import { useUIStore } from "~/hooks/useUIStore";
import type { UIMessage } from "ai";
import { draftOf, lastPrompt, MAX_SOURCES, retryTurn, sourcesOf, toolNameOf, turnFailed, usesDraftTool, type SavedDraft, type Source } from "./agent-chat";

/**
 * Where the panel sits decides what its links do: on the unified inbox a source opens in the reader
 * and a saved draft opens in its composer; on the legacy mailbox page neither is given.
 */
export interface AgentPanelProps {
	/** The Cloudflare mailbox the chat agent reads; the route's `:mailboxId` when absent. */
	mailboxId?: string;
	/** Opens a message an answer read (B11-03). Without it, sources are not listed. */
	onOpenSource?: (source: Source) => void;
	/** Opens a draft an answer saved in the composer. Without it, the legacy composer is used. */
	onEditDraft?: (draft: SavedDraft) => void;
	/** The message open in the reader, when it is on this mailbox: offered as the first prompts. */
	focus?: { emailId: string; subject: string } | null;
}

const TOOL_LABELS: Record<string, { label: string; icon: React.ReactNode }> = {
	list_emails: {
		label: msg("Fetching emails"),
		icon: <EnvelopeSimpleIcon size={14} weight="bold" />,
	},
	get_email: {
		label: msg("Reading email"),
		icon: <EyeIcon size={14} weight="bold" />,
	},
	get_thread: {
		label: msg("Loading thread"),
		icon: <ArrowBendUpLeftIcon size={14} weight="bold" />,
	},
	search_emails: {
		label: msg("Searching"),
		icon: <MagnifyingGlassIcon size={14} weight="bold" />,
	},
	draft_email: {
		label: msg("Drafting email"),
		icon: <PaperPlaneTiltIcon size={14} weight="bold" />,
	},
	draft_reply: {
		label: msg("Drafting reply"),
		icon: <PaperPlaneTiltIcon size={14} weight="bold" />,
	},
	discard_draft: {
		label: msg("Discarding draft"),
		icon: <TrashIcon size={14} weight="bold" />,
	},
	mark_email_read: {
		label: msg("Updating status"),
		icon: <CheckCircleIcon size={14} weight="bold" />,
	},
	move_email: {
		label: msg("Moving email"),
		icon: <EnvelopeSimpleIcon size={14} weight="bold" />,
	},
};

function ToolCallBadge({
	toolName,
	state,
}: {
	toolName: string;
	state: string;
}) {
	const t = useT();
	const info = TOOL_LABELS[toolName] || {
		label: toolName,
		icon: <WrenchIcon size={14} weight="bold" />,
	};
	// A failed tool call is not a finished one: it shows a warning, never the success check.
	const failed = state === "output-error";
	const isDone = state === "output-available" || state === "result";

	return (
		<div className="flex items-center gap-1.5 py-1 px-2 rounded bg-kumo-fill/50 text-xs">
			<span className="text-kumo-brand">{info.icon}</span>
			<span className="text-kumo-strong">{t.text(info.label)}</span>
			{failed ? (
				<span className="ml-auto flex items-center gap-1 text-kumo-error">
					<WarningCircleIcon size={12} weight="fill" aria-hidden="true" />
					{t("Failed")}
				</span>
			) : isDone ? (
				<CheckCircleIcon
					size={12}
					weight="fill"
					className="text-kumo-success ml-auto"
				/>
			) : (
				<Loader size="sm" className="ml-auto" />
			)}
		</div>
	);
}

function DraftActions({
	onEdit,
	disabled,
}: {
	onEdit: () => void;
	disabled: boolean;
}) {
	const t = useT();
	return (
		<div className="flex gap-1.5 mt-1">
			<Button
				variant="primary"
				size="sm"
				icon={<PencilSimpleIcon size={14} />}
				onClick={onEdit}
				disabled={disabled}
			>
				{t("Edit & send in composer")}
			</Button>
		</div>
	);
}

/**
 * The messages an answer read, as links into the reader (SCN-013 step 2, B11-03). Listed only where
 * the panel can open them; a source without a subject is named by its sender, then generically.
 */
export function SourceLinks({ sources, onOpen }: { sources: Source[]; onOpen: (source: Source) => void }) {
	const t = useT();
	if (!sources.length) return null;
	const shown = sources.slice(0, MAX_SOURCES);
	return (
		<div className="flex flex-col gap-0.5 mt-1 w-full">
			<span className="text-[11px] text-kumo-subtle">{t("Read for this answer")}</span>
			<ul className="flex flex-col gap-0.5 list-none p-0 m-0">
				{shown.map((source) => {
					const label = source.subject || (source.sender ? t("Message from {sender}", { sender: source.sender }) : t("A message in this mailbox"));
					return (
						<li key={source.emailId} className="min-w-0">
							<button
								type="button"
								onClick={() => onOpen(source)}
								className="flex items-center gap-1.5 w-full min-w-0 text-left text-xs text-kumo-link hover:underline bg-transparent border-0 p-0 cursor-pointer"
								aria-label={t("Open {message} in the reader", { message: label })}
							>
								<EnvelopeSimpleIcon size={12} className="shrink-0" />
								<span className="truncate">{label}</span>
							</button>
						</li>
					);
				})}
			</ul>
			{sources.length > shown.length && (
				<span className="text-[11px] text-kumo-subtle">
					{t.plural(sources.length - shown.length, { one: "and {n} more message", other: "and {n} more messages" })}
				</span>
			)}
		</div>
	);
}

/**
 * A turn that failed (B11-02): says so where the answer would be, keeps the question, and offers
 * Retry, which sends the same prompt again. Nothing is sent from the mailbox either way.
 */
export function ChatErrorBubble({ canRetry, onRetry }: { canRetry: boolean; onRetry: () => void }) {
	const t = useT();
	return (
		<div className="flex gap-2" role="alert">
			<div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-kumo-error">
				<WarningCircleIcon size={14} weight="bold" />
			</div>
			<div className="flex flex-col items-start gap-1.5 px-3 py-2 rounded-lg border border-kumo-line bg-kumo-elevated rounded-bl-sm max-w-[85%]">
				<span className="text-[13px] text-kumo-default">{t("The AI could not finish this answer.")}</span>
				<span className="text-xs text-kumo-subtle">{t("Your mail is as it was, apart from any step above marked done.")}</span>
				{canRetry && (
					<Button variant="secondary" size="sm" icon={<ArrowClockwiseIcon size={14} />} onClick={onRetry}>
						{t("Retry")}
					</Button>
				)}
			</div>
		</div>
	);
}

export function MessageBubble({
	message,
	onAction,
	onOpenSource,
	isStreaming,
}: {
	message: UIMessage;
	onAction?: (action: string) => void;
	onOpenSource?: (source: Source) => void;
	isStreaming: boolean;
}) {
	const isUser = message.role === "user";

	return (
		<div
			className={`flex gap-2 ${isUser ? "flex-row-reverse" : "flex-row"}`}
		>
			<div
				className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
					isUser
						? "bg-kumo-brand text-kumo-inverse"
						: "bg-kumo-fill text-kumo-default"
				}`}
			>
				{isUser ? (
					<UserIcon size={12} weight="bold" />
				) : (
					<RobotIcon size={12} weight="bold" />
				)}
			</div>
			<div
				className={`flex flex-col gap-1 max-w-[85%] min-w-0 ${
					isUser ? "items-end" : "items-start"
				}`}
			>
				{message.parts.map((part, i) => {
					const key = `${message.id}-part-${i}`;
					if (part.type === "text" && part.text.trim()) {
						return (
							<div
								key={key}
								className={`rounded-lg px-3 py-2 text-[13px] leading-relaxed break-words overflow-wrap-anywhere ${
									isUser
										? "bg-kumo-brand text-kumo-inverse rounded-br-sm"
										: "bg-kumo-elevated text-kumo-default border border-kumo-line rounded-bl-sm overflow-hidden"
								}`}
							>
								{isUser ? (
									part.text
								) : (
									<AgentMarkdown>{part.text}</AgentMarkdown>
								)}
							</div>
						);
					}
					const toolName = toolNameOf(part);
					if (toolName) {
						return (
							<ToolCallBadge
								key={key}
								toolName={toolName}
								state={(part as any).state ?? "running"}
							/>
						);
					}
					return null;
				})}
				{/* Show action buttons for draft replies */}
				{!isUser && usesDraftTool(message) && onAction && (
					<DraftActions
						onEdit={() => onAction("edit")}
						disabled={isStreaming}
					/>
				)}
				{!isUser && onOpenSource && (
					<SourceLinks sources={sourcesOf(message)} onOpen={onOpenSource} />
				)}
			</div>
		</div>
	);
}

/** The chat itself, given the agent client hooks (loaded lazily below; fakes in tests). */
export function AgentChatConnected({
	mailboxId,
	useAgent,
	useAgentChat,
	onOpenSource,
	onEditDraft,
	focus,
}: Omit<AgentPanelProps, "mailboxId"> & {
	mailboxId: string;
	useAgent: typeof import("agents/react").useAgent;
	useAgentChat: typeof import("@cloudflare/ai-chat/react").useAgentChat;
}) {
	const t = useT();
	const scrollRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const [inputValue, setInputValue] = useState("");
	const { startCompose } = useUIStore();

	const agent = useAgent({ agent: "EmailAgent", name: mailboxId });
	const { messages, sendMessage, status, setMessages, stop, error, regenerate, clearError } =
		useAgentChat({ agent });
	const isStreaming = status === "streaming" || status === "submitted";
	// A failed model turn (B11-02): an error bubble with Retry instead of silence.
	const failed = turnFailed(status, error);
	const retryable = lastPrompt(messages) !== null;
	const retry = () => retryTurn({ streaming: isStreaming, messages, clearError, regenerate: () => regenerate() });

	useEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [messages, failed]);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const handleSend = () => {
		const text = inputValue.trim();
		if (!text || isStreaming) return;
		setInputValue("");
		sendMessage({ text });
		if (inputRef.current) inputRef.current.style.height = "auto";
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	};

	// What the person would type: sent to the agent as their own words, in their language.
	const suggestedPrompts = [
		...(focus
			? [
				t("Explain the open message “{subject}” (message id {id})", { subject: focus.subject || t("(No subject)"), id: focus.emailId }),
				t("Draft a reply to the open message “{subject}” (message id {id})", { subject: focus.subject || t("(No subject)"), id: focus.emailId }),
			]
			: []),
		t("Show me the latest inbox emails"),
		t("Any unread emails?"),
		t("Draft a response to the latest email"),
	];

	return (
		<div className="flex flex-col h-full">
			{/* Header */}
			<div className="flex items-center justify-between px-3 py-1.5 border-b border-kumo-line shrink-0">
				<div className="flex items-center gap-2">
					<Badge variant="beta">AI</Badge>
					<span className="text-xs text-kumo-subtle">
						{t("Email Agent")}
					</span>
				</div>
				<div className="flex items-center gap-1">
					{isStreaming && <Loader size="sm" />}
					{messages.length > 0 && (
						<Tooltip content={t("Clear chat")} asChild>
							<Button
								variant="ghost"
								shape="square"
								size="sm"
								icon={<TrashIcon size={14} />}
								onClick={() => {
									if (window.confirm(t("Clear chat history?"))) {
										setMessages([]);
									}
								}}
								aria-label={t("Clear chat")}
							/>
						</Tooltip>
					)}
				</div>
			</div>

			{/* Messages */}
			<div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-4">
				{messages.length === 0 && !failed ? (
					<div className="flex flex-col items-center justify-center h-full gap-4">
						<div className="flex h-12 w-12 items-center justify-center rounded-xl bg-kumo-brand/10">
							<RobotIcon
								size={24}
								weight="duotone"
								className="text-kumo-brand"
							/>
						</div>
						<p className="text-xs text-kumo-subtle text-center leading-relaxed px-4">
							{t("I can read emails, search conversations, and draft replies.")}
						</p>
						<div className="flex flex-col gap-1.5 w-full">
							{suggestedPrompts.map((prompt) => (
								<button
									key={prompt}
									type="button"
									onClick={() =>
										sendMessage({ text: prompt })
									}
									className="text-left px-3 py-2 rounded-lg border border-kumo-line text-xs text-kumo-strong hover:bg-kumo-tint hover:border-kumo-fill-hover transition-colors cursor-pointer bg-transparent"
								>
									{prompt}
								</button>
							))}
						</div>
					</div>
				) : (
					<div className="flex flex-col gap-3">
						{messages.map((msg) => (
							<MessageBubble
								key={msg.id}
								message={msg}
								isStreaming={isStreaming}
								onOpenSource={onOpenSource}
								onAction={(action) => {
									if (action !== "edit") return;
									const draft = draftOf(msg);
									if (draft && onEditDraft) onEditDraft(draft);
									else if (draft) {
										startCompose({
											mode: draft.originalEmailId ? "reply" : "new",
											originalEmail: null,
											draftEmail: {
												id: draft.draftId,
												subject: draft.subject,
												sender: mailboxId,
												recipient: draft.to,
												date: new Date().toISOString(),
												read: true,
												starred: false,
												body: draft.body,
											},
										});
									} else {
										sendMessage({
											text: t("Let me edit this draft first. Show me what you have so I can modify it."),
										});
									}
								}}
							/>
						))}
						{failed && !isStreaming && <ChatErrorBubble canRetry={retryable} onRetry={retry} />}
						{isStreaming && (
							<div className="flex gap-2">
								<div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-kumo-default">
									<RobotIcon size={12} weight="bold" />
								</div>
								<div className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-kumo-elevated border border-kumo-line rounded-bl-sm">
									<Loader size="sm" />
									<span className="text-xs text-kumo-subtle">
										{t("Thinking...")}
									</span>
								</div>
							</div>
						)}
					</div>
				)}
			</div>

			{/* Input */}
			<div className="shrink-0 border-t border-kumo-line px-3 py-2">
				{isStreaming ? (
					<div className="flex justify-center">
						<Button
							variant="secondary"
							size="sm"
							icon={<StopIcon size={14} weight="fill" />}
							onClick={() => stop()}
						>
							{t("Stop generating")}
						</Button>
					</div>
				) : (
					<div className="flex items-end gap-1.5">
						<textarea
							ref={inputRef}
							id="agent-chat-input"
							name="agent-chat-input"
							value={inputValue}
							onChange={(e) => setInputValue(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder={t("Ask your email agent...")}
							rows={1}
							aria-label={t("Chat message input")}
							className="flex-1 resize-none rounded-lg border border-kumo-line bg-kumo-control px-3 py-2 text-xs text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring min-h-[36px] max-h-[100px]"
							style={{ height: "auto", overflow: "hidden" }}
							onInput={(e) => {
								const field = e.target as HTMLTextAreaElement;
								field.style.height = "auto";
								field.style.height = `${Math.min(field.scrollHeight, 100)}px`;
								field.style.overflow =
									field.scrollHeight > 100 ? "auto" : "hidden";
							}}
						/>
						<Button
							variant="primary"
							shape="square"
							size="sm"
							disabled={!inputValue.trim()}
							icon={<ArrowUpIcon size={14} weight="bold" />}
							onClick={handleSend}
							aria-label={t("Send message")}
						/>
					</div>
				)}
			</div>
		</div>
	);
}

export default function AgentPanel(props: AgentPanelProps = {}) {
	const t = useT();
	const params = useParams<{ mailboxId: string }>();
	const mailboxId = props.mailboxId ?? params.mailboxId;
	const [hooks, setHooks] = useState<{
		useAgent: typeof import("agents/react").useAgent;
		useAgentChat: typeof import("@cloudflare/ai-chat/react").useAgentChat;
	} | null>(null);

	const [loadFailed, setLoadFailed] = useState(false);

	useEffect(() => {
		Promise.all([
			import("agents/react"),
			import("@cloudflare/ai-chat/react"),
		]).then(([a, c]) =>
			setHooks({
				useAgent: a.useAgent,
				useAgentChat: c.useAgentChat,
			}),
		).catch((err) => {
			console.error("Failed to load agent modules:", err);
			setLoadFailed(true);
		});
	}, []);

	if (loadFailed) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-2 px-4 text-center">
				<span className="text-xs text-kumo-error">{t("Failed to connect to agent. Reload to retry.")}</span>
			</div>
		);
	}

	if (!hooks) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-2">
				<Loader size="base" />
				<span className="text-xs text-kumo-subtle">
					{t("Connecting...")}
				</span>
			</div>
		);
	}

	return (
		<AgentChatConnected
			mailboxId={mailboxId ?? "default"}
			useAgent={hooks.useAgent}
			useAgentChat={hooks.useAgentChat}
			onOpenSource={props.onOpenSource}
			onEditDraft={props.onEditDraft}
			focus={props.focus}
		/>
	);
}
