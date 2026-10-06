import { useT } from "~/lib/i18n";
import type { Step } from "~/services/domains";

/** What a domain action did, step by step (SCN-030/031); a failed step says how to continue. The server's words show in the interface's language. */
export default function StepList({ steps }: { steps: Step[] }) {
  const t = useT();
  if (!steps.length) return null;
  const mark: Record<Step["outcome"], string> = { done: t("Done"), already: t("Already so"), skipped: t("Nothing to do"), failed: t("Not done") };
  return (
    <ol className="fi-steps" aria-label={t("What was done")}>
      {steps.map((s) => (
        <li key={s.id} className={"fi-step is-" + s.outcome}>
          <span className="fi-step-mark">{mark[s.outcome]}</span>
          <span><strong>{t.text(s.label)}.</strong> {t.text(s.detail)}</span>
        </li>
      ))}
    </ol>
  );
}
