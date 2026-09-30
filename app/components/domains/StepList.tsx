import type { Step } from "~/services/domains";

const MARK: Record<Step["outcome"], string> = { done: "Done", already: "Already so", skipped: "Nothing to do", failed: "Not done" };

/** What a domain action did, step by step (SCN-030/031); a failed step says how to continue. */
export default function StepList({ steps }: { steps: Step[] }) {
  if (!steps.length) return null;
  return (
    <ol className="fi-steps" aria-label="What was done">
      {steps.map((s) => (
        <li key={s.id} className={"fi-step is-" + s.outcome}>
          <span className="fi-step-mark">{MARK[s.outcome]}</span>
          <span><strong>{s.label}.</strong> {s.detail}</span>
        </li>
      ))}
    </ol>
  );
}
