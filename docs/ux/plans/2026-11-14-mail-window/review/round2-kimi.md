- **KIMI-13 | S03 | blocking**  
  **Finding:** The verdict state machine is incoherent. Review runs only after an amber-or-higher signal, making “may raise to amber” effectively unreachable. Conversely, an unsignalled message can receive green without any tool-less model review. A lowered minor-signal verdict has no defined colour in §4, leaving S04’s behaviour undefined; “review not run” also sits uneasily with unreviewed green.  
  **Fix:** Define one pure state machine covering scheduling, every reason-code combination, invalid output, colour, badge and link policy. If green implies model verification, require that review; otherwise label green as deterministic checks only and remove the dead raise claim.

- **KIMI-14 | S03 | blocking**  
  **Finding:** Today’s reviewer emits `{verdict, reasons}`, and `safe` can release held mail. The target emits reason codes only, yet claims the existing review storage and release rule keep working while simultaneously forbidding the model to touch held state. No adapter or migration is specified; an implementation could either break arrival processing or preserve an unsafe release path.  
  **Fix:** Version and store the new output separately, reject malformed output without changing state, and explicitly remove automatic release or specify a clamped adapter that cannot release held mail or override floors.

- **KIMI-15 | S03 | major**  
  **Finding:** The fence does not clearly cover all attacker-controlled input. Deterministic signals and file judgements contain filenames, URLs and link text, but are described outside the message fence. Also, “quotes from the message” are not validated, so fabricated model text could appear as a quotation in trusted safety UI.  
  **Fix:** Serialize every attacker-derived string as untrusted data. Strictly validate output schemas and code combinations; require quotes to match normalized source spans exactly, render them inertly, and otherwise discard the review while retaining the deterministic colour.

- **KIMI-16 | S03, S04 | major**  
  **Finding:** A stale green record remains usable while feed recomputation is running or if it fails. S04 may therefore already have preserved clickable `href`s for a link newly added to the phishing feed.  
  **Fix:** Treat feed-stale records as grey before rendering the body, strip links, and restore the prior colour only after successful recomputation. Recompute failure must remain grey, with the body and link list regenerated atomically from the new record.

- **KIMI-17 | S03 | major**  
  **Finding:** Four KiB of signature data cannot reliably identify OOXML macros. Macro-enabled and ordinary OOXML files share ZIP signatures, and relevant manifest or macro parts may occur later. The current design can consequently claim “checked, no signal” without establishing the advertised file type.  
  **Fix:** Safely parse containers with decompression, size and nesting limits, or mark macro and archive inspection as not run. Never infer absence of macros from the prefix; propagate that uncertainty to the file chip and message colour.

- **KIMI-18 | S06 | blocking**  
  **Finding:** “Tune the agent” still crosses the prompt-injection boundary unsafely. Sender, subject and source titles are interpolated into the instruction prefix outside the fence; even a held message supplies these fields. Fence generation and forged-fence neutralization are also unspecified. Once the person submits the prepared prompt, attacker text reaches a tool-capable panel agent.  
  **Fix:** Put every variable field, including the draft and held-message metadata, into structured, length-delimited untrusted data with random fences and neutralization. Give this session read-only tools and require separate, explicit approval for any action or settings change.

- **KIMI-19 | S06, S07 | blocking**  
  **Finding:** Send can race autosave. Clicking Send within 1.5 seconds, or during save failure or revision conflict, can make `sendSavedDraft` transmit an older revision. Provider acceptance then lets S07 classify the stored draft as untouched and discard it while the person’s newest text exists only locally.  
  **Fix:** Make save-then-send sequential: flush edits, verify the expected revision or hash, then send that exact revision. Disable Send during saving, failure and conflict. Retirement must use the same expected revision, and “Keep as my draft” must preserve local text and restore an already-discarded draft.

- **KIMI-20 | S07 | major**  
  **Finding:** Provider content hashes are not reliably comparable. Gmail, IMAP or Outlook may normalize saved content, and existing runs have no `draftHash`. Misclassification can either discard externally edited work or prevent retirement indefinitely.  
  **Fix:** Define a canonical representation and store the hash of a provider-read-back draft. Treat missing, unreadable or incomparable hashes as unknown/edited and keep the draft. Add migration and provider-normalization tests.

- **KIMI-21 | S07 | major**  
  **Finding:** “Sent by anyone” remains unsupported. The hooks observe application send paths, not replies sent from another device or the provider’s own client; relying solely on In-Reply-To also misses replies containing only References. Such drafts remain visible contrary to the operator’s ask.  
  **Fix:** Reconcile during Sent-folder synchronization using internal ids, In-Reply-To and References, with deterministic thread matching. Do not retire drafts on ambiguous subject-only guesses; document the synchronization delay.

- **KIMI-22 | S03 | major**  
  **Finding:** “The current `main` commit at build time” is not a dependency pin. Safety-critical vendored code can change between otherwise identical builds, and hashes generated from that same checkout provide no independent integrity check.  
  **Fix:** Commit an exact reviewed Okolos revision and lockfile before building, record its hashes, and update it only through a reviewed dependency-change pull request.

[model: moonshotai/kimi-k3.1-pro, usage: {"prompt_tokens": 20939, "completion_tokens": 15664, "total_tokens": 36603, "cost": 0.143136095, "is_byok": false, "prompt_tokens_details": {"cached_tokens": 64, "cache_write_tokens": 0, "audio_tokens": 0, "video_tokens": 0}, "cost_details": {"upstream_inference_cost": 0.143136095, "upstream_inference_prompt_cost": 0.005292895, "upstream_inference_completions_cost": 0.1378432}, "completion_tokens_details": {"reasoning_tokens": 14415, "image_tokens": 0, "audio_tokens": 0}}]
