import { useQuery } from "@tanstack/react-query";
import { fabric } from "~/services/fabric";

/** The signed-in person on this server (B-149, GET /api/me). */
export interface Me { role: "admin" | "member" | "none"; email: string | null; accounts: string[] | null; listed: boolean }

/**
 * Who I am here. A server older than 0.30.0 has no /api/me: its answer fails, and the person is
 * the administrator there, as every signed-in person was.
 */
export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: () => fabric<Me>("/api/me"), staleTime: 60_000, retry: false });
}

/** Whether the screens offer what only an administrator may do: true until /api/me says otherwise. */
export const managesServer = (me: { data?: Me; isError?: boolean }) => me.data?.role !== "member";
