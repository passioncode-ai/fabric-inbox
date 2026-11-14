- **KIMI-41 | S03 | blocking**  
  **Finding:** The held-mail path still lets a tool-less model lower a safety decision. `reviewHeld` reads attacker-controlled content and can automatically release mail held only for `findings.model`, thereby allowing agents with tools to read it. Fencing the new review does not protect this separate path. This contradicts the revision’s own principle that a model’s reading of attacker text is not evidence of harmlessness.  
  **Fix:** Make the held review advisory only. Require a person to release model-only holds, or separate human-visible release from permission for tool-using agents, with the latter always requiring explicit human approval.

- **KIMI-42 | S03, S06 | blocking**  
  **Finding:** The new review’s detections do not protect reply agents. `instructions_to_ai` merely produces amber; it neither holds the message nor changes agent behaviour. Only red sender floors suppress automatic sending, and no ordering guarantees that the review finishes before the runner reads the message. A detected injection can therefore still reach tools, and phishing detections can still produce an automatic reply.  
  **Fix:** When a review is triggered, complete it before agent execution. Treat `instructions_to_ai` as blocking tool-agent access pending human review, and make other raising codes force a draft rather than automatic sending. Define behaviour for unavailable review budget without holding ordinary mail.

- **KIMI-43 | S03 | major**  
  **Finding:** Rechecking can silently undo a review-raised verdict. The review is stored inside `findings.check`, while deterministic rechecks and stale-feed recomputation rewrite that record without running the model. No merge or preservation rule is specified, so a previously raised amber message can revert to green, grey, or sender-only amber despite the “only upward” guarantee.  
  **Fix:** Persist the raising outcome separately or require rechecks to preserve and reapply it, keyed to an immutable content hash. Add tests for stale-feed recomputation and `POST /api/safety/check` after a review-raised verdict.

- **KIMI-44 | S06 | major**  
  **Finding:** The tuning session lacks the information needed to tune the agent. It receives source titles, agent name and version, but neither the current prompt/settings nor the cited knowledge contents. With no tools, it cannot inspect those itself, so its answer to “what in its settings would make it do so?” can only be generic guesswork.  
  **Fix:** Include an immutable snapshot of the agent’s versioned configuration and relevant source contents, clearly separated from untrusted mail, or grant narrowly read-only settings and knowledge capabilities. Keep all changes human-approved.

- **KIMI-45 | S06, S07, README | major**  
  **Finding:** Retirement storage remains contradictory. Q7 says every untouched draft moves to Discarded for 30 days; S06 says Discard moves a draft there; S07 says Discarded cannot accept drafts, deletes Cloudflare drafts, and merely hides account drafts. S07’s edge case still instructs restoration from Discarded. These cannot all be implemented.  
  **Fix:** Make the round-5 S07 design normative. Define explicit user-initiated Discard separately, restore Cloudflare drafts from their run snapshot, restore account drafts by clearing their hidden marker, and update Q7, S06, S07, and tests.

- **KIMI-46 | S07 | major**  
  **Finding:** Cloudflare retirement is not always recoverable. Existing runs may lack `draftText`, yet their revision-1 drafts can still be deleted. New snapshots are capped at 20,000 characters, so “Make a draft of it again” can silently recreate a truncated draft.  
  **Fix:** Read and retain a complete restorable snapshot in the retirement transaction, including all fields needed for restoration. If a complete snapshot is unavailable, keep the draft instead of deleting it. Test legacy runs and oversized drafts.

- **KIMI-47 | S04 | major**  
  **Finding:** The `postMessage` boundary validates payload shape but not message provenance. A forged message containing a valid index from another frame or window is not expressly rejected; the acceptance test covers only substitution of a URL. This matters especially for remembered “Open anyway” decisions.  
  **Fix:** Bind each listener and link list to the expected frame’s `contentWindow` and a per-render nonce, validate the index and user activation, and re-evaluate the current safety decision on every activation. Test a forged valid index from an unrelated source.

- **KIMI-48 | S06, S07 | major**  
  **Finding:** The unsaved-edit race is asserted away rather than solved. Until the first immediate save is acknowledged, the server still sees revision 1 or `agentDraftRevision` and can delete or hide the draft as untouched. S07 nevertheless says a card with unsaved edits is kept. The full-composer path has no equivalent protection.  
  **Fix:** Specify a dirty-client retirement protocol that preserves local text, creates or restores a person-owned draft before closing the editor, and covers failed saves. Add tests where an external reply arrives before the first autosave in both the card and composer.

- **KIMI-49 | S07 | minor**  
  **Finding:** Reply detection differs by path. Accepted in-app sends require `In-Reply-To`, while Sent synchronization also accepts `References`. A References-only reply can therefore retire drafts late or not at all, and the replied-to message used for the “or earlier” rule is undefined.  
  **Fix:** Use one resolver everywhere: prefer `In-Reply-To`, otherwise define which thread message in `References` is the parent, and test identical sends through acceptance and synchronization.

[model: moonshotai/kimi-k3.1-pro, usage: {"prompt_tokens": 20325, "completion_tokens": 19535, "total_tokens": 39860, "cost": 0.1863636, "is_byok": false, "prompt_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 0, "audio_tokens": 0, "video_tokens": 0}, "cost_details": {"upstream_inference_cost": 0.1863636, "upstream_inference_prompt_cost": 0.0140649, "upstream_inference_completions_cost": 0.1722987}, "completion_tokens_details": {"reasoning_tokens": 18317, "image_tokens": 0, "audio_tokens": 0}}]
