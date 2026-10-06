// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Pagination, Tooltip } from "@cloudflare/kumo";
import {
	ArchiveIcon,
	ArrowBendUpLeftIcon,
	ArrowsClockwiseIcon,
	EnvelopeOpenIcon,
	EnvelopeSimpleIcon,
	FileIcon,
	PaperPlaneTiltIcon,
	PencilSimpleIcon,
	StarIcon,
	TrashIcon,
	TrayIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { Folders } from "shared/folders";
import { formatListDate } from "shared/dates";
import { msg } from "../../shared/i18n";
import LoadError from "~/components/LoadError";
import MailboxSplitView from "~/components/MailboxSplitView";
import PermanentDeleteDialog from "~/components/PermanentDeleteDialog";
import { useDeleteMessage } from "~/hooks/useDeleteMessage";
import { TRASH_EMPTY_STATE } from "~/lib/delete-policy";
import { useT } from "../lib/i18n";
import { isRowActivation } from "~/lib/row-keys";
import { getSnippetText } from "~/lib/utils";
import {
	useEmails,
	useMarkThreadRead,
	useUpdateEmail,
} from "~/queries/emails";
import { useFolders } from "~/queries/folders";
import { queryKeys } from "~/queries/keys";
import { useUIStore } from "~/hooks/useUIStore";
import { useWindowActive } from "~/hooks/useWindowActive";
import { pollInterval } from "~/lib/window-activity";
import type { Email } from "~/types";

const PAGE_SIZE = 25;

/** Folders the server names itself (in English): their names are shown through t.text(). */
const SYSTEM_FOLDERS: readonly string[] = Object.values(Folders);

const FOLDER_EMPTY_STATES: Record<
	string,
	{
		icon: React.ReactNode;
		title: string;
		description: string;
		showCompose?: boolean;
	}
> = {
	[Folders.INBOX]: {
		icon: <TrayIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: msg("Your inbox is empty"),
		description:
			msg("New emails will appear here when they arrive. Send an email to get the conversation started."),
		showCompose: true,
	},
	[Folders.SENT]: {
		icon: (
			<PaperPlaneTiltIcon size={48} weight="thin" className="text-kumo-subtle" />
		),
		title: msg("No sent emails"),
		description: msg("Emails you send will show up here."),
		showCompose: true,
	},
	[Folders.DRAFT]: {
		icon: <FileIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: msg("No drafts"),
		description: msg("Emails you're still working on will be saved here."),
		showCompose: true,
	},
	[Folders.ARCHIVE]: {
		icon: <ArchiveIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: msg("Archive is empty"),
		description:
			msg("Move emails here to keep your inbox clean without deleting them."),
	},
	[Folders.TRASH]: {
		icon: <TrashIcon size={48} weight="thin" className="text-kumo-subtle" />,
		...TRASH_EMPTY_STATE,
	},
};

function EmailListSkeleton() {
	return (
		<div className="animate-pulse space-y-1 p-2">
			{Array.from({ length: 8 }).map((_, i) => (
				<div key={i} className="flex items-center gap-3 px-3 py-3">
					<div className="w-4 h-4 rounded bg-kumo-fill" />
					<div className="w-5 h-5 rounded bg-kumo-fill" />
					<div className="flex-1 space-y-2">
						<div className="flex items-center gap-2">
							<div className="h-3 w-24 rounded bg-kumo-fill" />
							<div className="h-3 w-4 rounded bg-kumo-fill" />
							<div className="h-3 flex-1 rounded bg-kumo-fill" />
							<div className="h-3 w-12 rounded bg-kumo-fill" />
						</div>
						<div className="h-2.5 w-3/4 rounded bg-kumo-fill" />
					</div>
				</div>
			))}
		</div>
	);
}

function FolderEmptyState({
	folder,
	onCompose,
}: {
	folder?: string;
	onCompose: () => void;
}) {
	const config = (folder && FOLDER_EMPTY_STATES[folder]) || {
		icon: (
			<EnvelopeSimpleIcon size={48} weight="thin" className="text-kumo-subtle" />
		),
		title: msg("No emails"),
		description: msg("This folder is empty."),
	};
	const t = useT();

	return (
		<div className="flex flex-col items-center justify-center py-24 px-6 text-center">
			<div className="mb-4">{config.icon}</div>
			<h3 className="text-base font-semibold text-kumo-default mb-1.5">
				{t.text(config.title)}
			</h3>
			<p className="text-sm text-kumo-subtle max-w-xs mb-5">
				{t.text(config.description)}
			</p>
			{"showCompose" in config && config.showCompose && (
				<Button
					variant="primary"
					size="sm"
					icon={<PencilSimpleIcon size={16} />}
					onClick={onCompose}
				>
					{t("Compose")}
				</Button>
			)}
		</div>
	);
}

export default function EmailListRoute() {
	const t = useT();
	const { mailboxId, folder } = useParams<{
		mailboxId: string;
		folder: string;
	}>();
	const {
		selectedEmailId,
		isComposing,
		selectEmail,
		closePanel,
		startCompose,
	} = useUIStore();
	const [page, setPage] = useState(1);

	const queryClient = useQueryClient();
	const updateEmail = useUpdateEmail();
	const markThreadRead = useMarkThreadRead();
	const { requestDelete, deleteLabel, dialogProps } = useDeleteMessage(
		mailboxId,
		folder,
	);

	const params = useMemo(
		() => ({
			folder: folder || "",
			page: String(page),
			limit: String(PAGE_SIZE),
		}),
		[folder, page],
	);

	// Read again every 30 s while this window is active; never while it is hidden or in the background.
	const windowActive = useWindowActive();
	const {
		data: emailData,
		error: loadError,
		isError: loadFailed,
		isFetching: isRefreshing,
		refetch: refetchEmails,
	} = useEmails(mailboxId, params, { refetchInterval: pollInterval(windowActive, 30_000) });

	const emails = emailData?.emails ?? [];
	const totalCount = emailData?.totalCount ?? 0;

	const { data: folders = [] } = useFolders(mailboxId);

	const folderName = useMemo(() => {
		const found = folders.find((f) => f.id === folder);
		const system = !!folder && SYSTEM_FOLDERS.includes(folder);
		if (found) return system ? t.text(found.name) : found.name;
		if (!folder) return t("Inbox");
		const name = folder.charAt(0).toUpperCase() + folder.slice(1);
		return system ? t.text(name) : name;
	}, [folders, folder, t]);

	const isPanelOpen = selectedEmailId !== null || isComposing;

	// Track folder identity to detect folder changes vs page changes
	const prevFolderRef = useRef<string | undefined>(undefined);

	// A deep link (?open=<id>, e.g. "Open the draft" on Agents) opens that message.
	// Arriving on a folder normally closes the panel; with ?open= it selects instead,
	// and the parameter is dropped only once the selection took, so a second mount
	// (the route's first load can mount twice) still sees it.
	const [searchParams, setSearchParams] = useSearchParams();
	const openId = searchParams.get("open");

	useEffect(() => {
		const folderChanged = prevFolderRef.current !== `${mailboxId}/${folder}`;
		prevFolderRef.current = `${mailboxId}/${folder}`;

		if (folderChanged) {
			if (openId) selectEmail(openId);
			else closePanel();
			setPage(1);
		}
	}, [mailboxId, folder, closePanel, openId, selectEmail]);

	useEffect(() => {
		if (!openId) return;
		if (selectedEmailId !== openId) { selectEmail(openId); return; }
		setSearchParams((p) => { p.delete("open"); return p; }, { replace: true });
	}, [openId, selectedEmailId, selectEmail, setSearchParams]);

	const toggleStar = (e: React.MouseEvent, email: Email) => {
		e.preventDefault();
		e.stopPropagation();
		if (mailboxId)
			updateEmail.mutate({
				mailboxId,
				id: email.id,
				data: { starred: !email.starred },
			});
	};

	// Outside Trash this moves the message to Trash (with Undo); inside Trash
	// it asks to confirm, then deletes permanently. See ~/lib/delete-policy.
	const handleDelete = (e: React.MouseEvent, email: Email) => {
		e.preventDefault();
		e.stopPropagation();
		requestDelete(email, () => {
			if (useUIStore.getState().selectedEmailId === email.id) closePanel();
		});
	};

	const handleRefresh = () => {
		if (mailboxId) {
			queryClient.invalidateQueries({ queryKey: ["emails", mailboxId] });
			queryClient.invalidateQueries({
				queryKey: queryKeys.folders.list(mailboxId),
			});
		}
	};

	// Thread-aware helpers
	const hasUnread = (email: Email): boolean => {
		if (email.thread_unread_count !== undefined) {
			return email.thread_unread_count > 0;
		}
		return !email.read;
	};

	const handleRowClick = (email: Email) => {
		selectEmail(email.id);
		if (mailboxId && hasUnread(email)) {
			if (email.thread_id && email.thread_count && email.thread_count > 1) {
				markThreadRead.mutate({
					mailboxId,
					threadId: email.thread_id,
				});
			} else {
				updateEmail.mutate({
					mailboxId,
					id: email.id,
					data: { read: true },
				});
			}
		}
	};

	const formatParticipants = (email: Email): string => {
		if (email.participants) {
			const names = email.participants
				.split(",")
				.map((p) => p.trim().split("@")[0])
				.filter((name, idx, arr) => arr.indexOf(name) === idx);
			if (names.length <= 3) return names.join(", ");
			return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
		}
		return email.sender.split("@")[0];
	};

	return (
		<MailboxSplitView
			selectedEmailId={selectedEmailId}
			isComposing={isComposing}
		>
				{/* Folder header */}
				<div className="flex items-center justify-between px-4 py-3.5 border-b border-kumo-line shrink-0 md:px-5">
					<h1 className="text-lg font-semibold text-kumo-default">
						{folderName}
					</h1>
					<div className="flex items-center gap-1">
						{totalCount > 0 && (
							<span className="text-sm text-kumo-subtle mr-2 hidden sm:inline">
								{t.plural(totalCount, { one: "{n} conversation", other: "{n} conversations" })}
							</span>
						)}
						<Tooltip
							content={isRefreshing ? t("Refreshing...") : t("Refresh")}
							side="bottom"
							asChild
						>
							<Button
								variant="ghost"
								shape="square"
								size="sm"
								icon={
									<ArrowsClockwiseIcon
										size={18}
										className={isRefreshing ? "animate-spin" : ""}
									/>
								}
								onClick={handleRefresh}
								disabled={isRefreshing}
								aria-label={t("Refresh")}
							/>
						</Tooltip>
					</div>
				</div>

				{/* Email rows */}
				<div className="flex-1 overflow-y-auto">
				{loadFailed && emails.length > 0 && (
					<LoadError
						compact
						title={t("Couldn't refresh {folder}.", { folder: folderName })}
						error={loadError}
						onRetry={() => refetchEmails()}
						retrying={isRefreshing}
					/>
				)}
				{isRefreshing && emails.length === 0 ? (
					<EmailListSkeleton />
				) : loadFailed && emails.length === 0 ? (
					<LoadError
						title={t("Couldn't load {folder}", { folder: folderName })}
						error={loadError}
						onRetry={() => refetchEmails()}
					/>
				) : emails.length > 0 ? (
						<div>
							{emails.map((email) => {
								const isSelected = selectedEmailId === email.id;
								const snippet = getSnippetText(email.snippet);
								return (
									<div
										key={email.id}
										role="button"
										tabIndex={0}
										onClick={() => handleRowClick(email)}
										onKeyDown={(e) => {
											// Keys on the nested star/read/delete buttons belong to them.
											if (isRowActivation(e)) {
												e.preventDefault();
												handleRowClick(email);
											}
										}}
										className={`group flex items-center gap-3 w-full text-left cursor-pointer transition-colors border-b border-kumo-line px-4 py-2.5 md:px-6 md:py-3 ${
											isPanelOpen ? "md:px-4 md:py-2.5" : ""
										} ${isSelected ? "bg-kumo-tint" : "hover:bg-kumo-tint"}`}
									>
										{/* Unread dot */}
										<div className="w-2.5 shrink-0 flex justify-center">
											{hasUnread(email) && (
												<div className="h-2 w-2 rounded-full bg-kumo-brand" />
											)}
										</div>

										{/* Star */}
										<button
											type="button"
											className="shrink-0 p-0.5 bg-transparent border-0 cursor-pointer"
											aria-label={email.starred ? t("Unstar") : t("Star")}
											aria-pressed={email.starred}
											onClick={(e) => {
												e.stopPropagation();
												toggleStar(e, email);
											}}
										>
											<StarIcon
												size={16}
												weight={email.starred ? "fill" : "regular"}
												className={
													email.starred
														? "text-kumo-warning"
														: "text-kumo-subtle hover:text-kumo-warning"
												}
											/>
										</button>

										{/* Content */}
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2">
												<span
													className={`truncate text-sm ${hasUnread(email) ? "font-semibold text-kumo-default" : "text-kumo-strong"}`}
												>
													{formatParticipants(email)}
												</span>
												{(email.thread_count ?? 1) > 1 && (
													<span className="shrink-0 text-xs text-kumo-subtle bg-kumo-fill rounded-full px-1.5 py-0.5 font-medium">
														{email.thread_count}
													</span>
												)}
												{email.has_draft && (
													<span className="shrink-0 text-xs text-kumo-destructive font-medium">
														{t("Draft")}
													</span>
												)}
												{email.needs_reply && !email.has_draft && (
													<Tooltip content={t("Needs reply")} asChild>
														<span className="shrink-0 text-kumo-warning">
															<ArrowBendUpLeftIcon size={14} weight="bold" />
														</span>
													</Tooltip>
												)}
												<span className="text-sm text-kumo-subtle shrink-0 ml-auto">
													{formatListDate(email.date, t.locale)}
												</span>
											</div>
											<div className="truncate text-sm mt-0.5">
												<span
													className={hasUnread(email) ? "font-medium text-kumo-default" : "text-kumo-subtle"}
												>
													{email.subject}
												</span>
											{snippet && (
												<span className="text-kumo-subtle font-normal">
													{" "}— {snippet}
												</span>
											)}
										</div>
									</div>

										{/* Row actions: on hover, and whenever focus is inside the row */}
										<div className="hidden group-hover:flex group-focus-within:flex items-center shrink-0">
											<Tooltip content={email.read ? t("Mark unread") : t("Mark read")} asChild>
												<Button
													variant="ghost"
													shape="square"
													size="sm"
													icon={email.read ? <EnvelopeSimpleIcon size={14} /> : <EnvelopeOpenIcon size={14} />}
													onClick={(e) => {
														e.stopPropagation();
														if (mailboxId)
															updateEmail.mutate({
																mailboxId,
																id: email.id,
																data: { read: !email.read },
															});
													}}
													aria-label={email.read ? t("Mark unread") : t("Mark read")}
												/>
											</Tooltip>
											<Tooltip content={t.text(deleteLabel(email))} asChild>
												<Button
													variant="ghost"
													shape="square"
													size="sm"
													icon={<TrashIcon size={14} />}
													onClick={(e) => handleDelete(e, email)}
													aria-label={t.text(deleteLabel(email))}
												/>
											</Tooltip>
										</div>
									</div>
								);
							})}
						</div>
					) : (
						<FolderEmptyState
							folder={folder}
							onCompose={() => startCompose()}
						/>
					)}
				</div>

				{/* Pagination */}
				{totalCount > PAGE_SIZE && (
					<div className="flex justify-center py-3 border-t border-kumo-line shrink-0">
						<Pagination
							page={page}
							setPage={setPage}
							perPage={PAGE_SIZE}
							totalCount={totalCount}
						/>
					</div>
				)}
				<PermanentDeleteDialog {...dialogProps} />
		</MailboxSplitView>
	);
}
