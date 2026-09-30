# Fabric Inbox UX entry point

Read [foundation](foundation.md), [flows](flows.md), [screens](screens.md), then [scenarios](scenarios.md). This is a formal specification for the approved [desktop brief](../desktop-mail/brief.md), not a claim that the new behavior is implemented. Source baseline and known defects remain in [evidence](../desktop-mail/evidence.md).

The owner approved macOS, all-account mail, AI actions and cloud automation on 2026-09-26. Unknown additional providers and first real tools stay open. No personal mailbox contents were read. No interviews, telemetry, production acceptance or Figma frames were collected.

Behavior directly inherited from the approved scope is validated as a requirement. Detailed proposed recovery policies stay draft. All Product states are unobserved. Integrated source pointers and Today fields now describe partial coverage; see the [integration receipt](implementation-receipt.md). Native fixture observations and workerd tests are engineering evidence, not user-outcome signals. A later implementation audit must inspect each expected result before changing status to implemented.

Run `python3 docs/ux/lint.py`, `python3 docs/ux/doctor.py .`, and `python3 docs/brand/lint.py` from the repository root. These check document consistency, not runtime behavior. Seeded scripts are unmodified super-ux 0.56.2 scripts, MIT licensed.

Next task: see the [release entry](../app-store/README.md) (the integration receipt is history); within UX, verify controlled provider/desktop flows, preserve explicit draft decisions and walk keyboard, loading, error and offline states in the running app. Real provider connection requires configured credentials and controlled accounts; cloud execution requires a deployed worker. Optional Figma choice remains with the root task; no external design file has been created.
