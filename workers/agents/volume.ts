import type { Env } from "../types";
import { readAssignment } from "./definition";
import { readAllSettings } from "../lib/mailbox-store";

/** One agent address on one UTC day: counts only, never a sender, subject or text (B-126). */
export interface VolumeDay {
  day: string;
  /** Messages that came to the address that day (spam not included). */
  received: number;
  /** Messages a reply agent ran on that day (answered, drafted, held, left alone, handed off). */
  agentRuns: number;
  /** Received with no agent run: received minus agentRuns, never below 0. */
  noRun: number;
  /** Messages that went to Spam that day. */
  spam: number;
}

export interface MailVolume {
  from: string;
  to: string;
  addresses: { address: string; agentId: string; days: VolumeDay[] }[];
  /** Agent runs older than this were pruned, so their days count no runs; null when none were. */
  runsKeptFrom: string | null;
}

const DAY = 86_400_000;

/**
 * Mail volume per agent address and UTC day over the last `days` days, today included: how much came,
 * how much a reply agent ran on, and how much it did not (B-126). Addresses with no agent are left out.
 */
export async function mailVolume(env: Env, days: number, now = Date.now()): Promise<MailVolume> {
  const span = Math.min(Math.max(Math.trunc(days) || 1, 1), 30);
  const today = new Date(now).toISOString().slice(0, 10);
  const first = new Date(Date.parse(today) - (span - 1) * DAY).toISOString().slice(0, 10);
  const since = `${first}T00:00:00.000Z`;
  const served = (await readAllSettings(env.BUCKET))
    .map(({ email, settings }) => ({ address: email.toLowerCase(), assignment: readAssignment(settings) }))
    .filter((x): x is { address: string; assignment: { id: string } } => !!x.assignment && x.assignment !== "off");
  const runs = await env.AGENT_REGISTRY.getByName("workspace").runsPerDay(since);
  const runsOf = new Map(runs.counts.map((r) => [`${r.mailboxId.toLowerCase()} ${r.day}`, r.runs]));
  const dayList = Array.from({ length: span }, (_, i) => new Date(Date.parse(first) + i * DAY).toISOString().slice(0, 10));
  const addresses = await Promise.all(served.map(async ({ address, assignment }) => {
    const received = new Map((await env.MAILBOX.get(env.MAILBOX.idFromName(address)).receivedPerDay(since)).map((r) => [r.day, r]));
    return {
      address, agentId: assignment.id,
      days: dayList.map((day) => {
        const got = received.get(day);
        const agentRuns = runsOf.get(`${address} ${day}`) ?? 0;
        const count = got?.received ?? 0;
        return { day, received: count, agentRuns, noRun: Math.max(count - agentRuns, 0), spam: got?.spam ?? 0 };
      }),
    };
  }));
  addresses.sort((a, b) => a.address.localeCompare(b.address));
  return { from: first, to: today, addresses, runsKeptFrom: runs.keptFrom };
}
