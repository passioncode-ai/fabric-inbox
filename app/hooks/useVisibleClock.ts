import { useEffect, useState } from "react";

/**
 * The time now, ticking every `ms` only while the page is visible (LC-08: nothing runs for a hidden
 * window); coming back reads the clock at once. Only the component that calls it re-renders, so a
 * relative time ("2 min ago") never re-renders the message list beside it.
 */
export function useVisibleClock(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (timer || document.visibilityState !== "visible") return;
      setNow(Date.now());
      timer = setInterval(() => setNow(Date.now()), ms);
    };
    const stop = () => { if (timer) clearInterval(timer); timer = undefined; };
    const change = () => (document.visibilityState === "visible" ? start() : stop());
    start();
    document.addEventListener("visibilitychange", change);
    return () => { stop(); document.removeEventListener("visibilitychange", change); };
  }, [ms]);
  return now;
}
