- **KIMI-25 | S03 | blocking**
  **Finding:** Content sniffing is explicitly colour-only and never holds mail. A `.pdf` whose bytes identify a PE can therefore pass the existing name-based arrival check and reach tool-using agents. The new disguised-file release guard only helps if the message was already held for another reason, so it does not protect the pre-agent trust boundary.
  **Fix:** Feed executable and disguised-file byte findings into the pre-agent hold decision, or make tool authorization deny message and attachment access whenever such a floor exists until release. Test that a clean-named disguised executable cannot be read by agent tools.

- **KIMI-26 | S03 | blocking**
  **Finding:** The clamp still lets attacker-controlled text downgrade major Reply-To and display-name findings. Fencing and schema validation validate the answer's form, not its truth; an injected request can elicit `likely_benign_sender_mismatch` alone, producing grey “Reviewed: probably fine”. With otherwise clean links, S04 can then allow direct opening. The final reference to a “minor” sender signal also contradicts the stated Okolos `major` severity.
  **Fix:** Make this review raise-only. If lowering is required, base it on independent deterministic evidence such as verified prior correspondence, require all other checks to have completed cleanly, and never treat a model assertion about attacker text as exculpatory.

- **KIMI-27 | S03 | major**
  **Finding:** Lookalikes are declared floors, but the colour table does not map them completely: red omits lookalike From addresses and links, while generic amber excludes floors. In particular, a lookalike link has no unambiguous `colourOf` result, risking inconsistent or fail-open implementations.
  **Fix:** Give lookalike From and link findings explicit colours, state whether each is red or non-lowerable amber, and align Q2, S03, S04 and the colour-table tests.

- **KIMI-28 | S04 | major**
  **Finding:** S03 requires sent messages and drafts with forwarded content to receive a links check and be guarded by S04. S04 instead says “Sent mail and drafts are not guarded”, and its acceptance test repeats that blanket exemption. A forwarded phishing link can consequently open without the required notice.
  **Fix:** Remove the blanket exemption. Specify that forwarded content in sent mail, saved drafts and composer previews is checked and guarded, while ordinary sent content remains unguarded. Add feed-listed and stale-feed forwarding tests.

- **KIMI-29 | S06/S07 | blocking**
  **Finding:** One `draftHash` cannot safely serve both optimistic concurrency and untouched-versus-edited detection. After the first account save it must advance to permit another save, but must remain the agent's original hash for S07's comparison. Additionally, read-hash-compare followed by provider update or send is not atomic, so an external edit can be overwritten or different content can be sent.
  **Fix:** Keep an immutable `agentDraftHash` plus a separate current concurrency token. Use provider-supported conditional mutations where available; otherwise send an immutable content snapshot and preserve any concurrently changed provider draft. Test successive autosaves and read/write/send races.

- **KIMI-30 | S07 | major**
  **Finding:** The claim that a card with unsaved edits “is edited, so it is kept” is not implementable by the described server logic. Until autosave, the server still sees revision 1 or the original hash and retires the draft as untouched. A crash, close or failed subsequent save can lose the person's local work.
  **Fix:** Persist a durable dirty/edited marker immediately on the first edit, coordinated with retirement, and retain recoverable local text until that marker or save is acknowledged. Test retirement during the 1.5-second autosave window.

- **KIMI-31 | S07 | major**
  **Finding:** `draftHash` covers attachment names and sizes, but attachment contents are editable. Replacing a file with different bytes of the same name and size leaves the hash unchanged, so a person's edited draft can be classified as untouched and removed from Drafts.
  **Fix:** Include a cryptographic content digest or a reliable provider revision for attachments. Where content identity cannot be established, conservatively classify the draft as edited and keep it.

[model: moonshotai/kimi-k3.1-pro, usage: {"prompt_tokens": 17839, "completion_tokens": 17381, "total_tokens": 35220, "cost": 0.157461395, "is_byok": false, "prompt_tokens_details": {"cached_tokens": 64, "cache_write_tokens": 0, "audio_tokens": 0, "video_tokens": 0}, "cost_details": {"upstream_inference_cost": 0.157461395, "upstream_inference_prompt_cost": 0.004508595, "upstream_inference_completions_cost": 0.1529528}, "completion_tokens_details": {"reasoning_tokens": 16462, "image_tokens": 0, "audio_tokens": 0}}]
