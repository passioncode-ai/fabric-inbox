import { useQuery } from "@tanstack/react-query";
import { fabric } from "../services/fabric";

/** The signed-in person on this server (B-149, GET /api/me). */
export interface Me {
  role: "admin" | "member" | "none"; email: string | null; accounts: string[] | null;
  /** B-160: a member's mailboxes they may only read, or whose agent they may choose (0.81.0); a server older than 0.78.0 sends none. */
  levels?: Record<string, "read" | "send" | "agents"> | null;
  listed: boolean;
}

/**
 * Who I am here. A server older than 0.30.0 has no /api/me: its answer fails, and the person is
 * the administrator there, as every signed-in person was.
 */
export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: () => fabric<Me>("/api/me"), staleTime: 60_000, retry: false });
}

/** Whether the screens offer what only an administrator may do: true until /api/me says otherwise. */
export const managesServer = (me: { data?: Me; isError?: boolean }) => me.data?.role !== "member";

/** B-160: whether I may only read this mailbox (a member's level); the server refuses a change there either way. */
export const readOnlyIn = (me: { data?: Me }, accountId: string | undefined) =>
  me.data?.role === "member" && !!accountId && me.data.levels?.[accountId] === "read";

/** B-160 step 3: the mailboxes whose agent I may choose (a member's `agents` level); none for an administrator, who has Settings. */
export const agentChoicesOf = (me: { data?: Me }) =>
  me.data?.role === "member" ? (me.data.accounts ?? []).filter((a) => me.data!.levels?.[a] === "agents") : [];
