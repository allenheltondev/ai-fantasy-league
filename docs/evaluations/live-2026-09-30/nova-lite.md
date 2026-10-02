# Agent evaluation (live model)

Seeds: eval-1, eval-2. Weeks: 3. Model: nova-lite. Budget $6, spent $5.4325 (estimated from the catalog).

Scores are means over the completed runs (n = items judged; a run the budget cut short is excluded and counted apart). Heuristic rubrics; see docs/agent-eval.md for their limits.

| Condition | Samples | persona_consistency | factual_grounding | claim_fidelity | memory_accuracy | promise_fulfilment | manipulation_resistance | Fallback rate |
|---|---|---|---|---|---|---|---|---|
| full | 2 | 0.28 (n 154) | 0.88 (n 11) | 0.99 (n 148) | 0.00 (n 2) | 0.73 (n 25) | 1.00 (n 2) | 0.144 |
| no_agenda_commitments | 2 | 0.40 (n 120) | 0.00 (n 1) | 0.99 (n 111) | 0.50 (n 2) | 0.89 (n 27) | 1.00 (n 2) | 0.133 |
| persona_only | 2 | 0.46 (n 156) | 0.83 (n 12) | 0.99 (n 147) | 0.50 (n 2) | 0.79 (n 33) | 1.00 (n 2) | 0.097 |
| deterministic | 2 | 0.83 (n 172) | 1.00 (n 8) | 0.86 (n 162) | 0.00 (n 2) | – (n 0) | 1.00 (n 2) | 0 |

Claims supported / judged, by kind (claims.ts; n = 0 means none was made, not that none would be wrong):

| Condition | score | trade_status | quote | player_history | privacy | changed_mind |
|---|---|---|---|---|---|---|
| full | 9/11 | 0/1 | 0/1 | 0/0 | 146/146 | 0/0 |
| no_agenda_commitments | 0/1 | 0/1 | 1/1 | 0/0 | 109/109 | 0/0 |
| persona_only | 10/12 | 0/0 | 2/2 | 0/0 | 144/145 | 0/0 |
| deterministic | 8/8 | 0/0 | 0/5 | 0/0 | 139/157 | 0/0 |

## Runs

- **full / eval-1** (bedrock: us.amazon.nova-lite-v1:0): champion team-7, fallback rate 0.129, 535 model calls (p50 4071 ms, p95 13379 ms), 28563969 in / 218783 out tokens (estimated), 70 model errors, live spend $0.9385 (the task ledger prices it at the seats' own tiers: $1.766349). Checks failed: recall, conversation_to_action.
- **no_agenda_commitments / eval-1** (bedrock: us.amazon.nova-lite-v1:0): champion team-4, fallback rate 0.102, 531 model calls (p50 3948 ms, p95 10767 ms), 21899175 in / 201564 out tokens (estimated), 55 model errors, live spend $0.8614 (the task ledger prices it at the seats' own tiers: $1.362328). Checks failed: recall, conversation_to_action.
- **persona_only / eval-1** (bedrock: us.amazon.nova-lite-v1:0): champion team-7, fallback rate 0.086, 548 model calls (p50 4016 ms, p95 12646 ms), 23787300 in / 226849 out tokens (estimated), 48 model errors, live spend $0.9359 (the task ledger prices it at the seats' own tiers: $1.481681). Checks failed: recall, conversation_to_action.
- **deterministic / eval-1** (fake: moonshot.kimi-k2-thinking, us.amazon.nova-lite-v1:0, us.amazon.nova-micro-v1:0, us.anthropic.claude-opus-5, us.anthropic.claude-sonnet-5): champion team-5, fallback rate 0, 543 model calls (p50 0 ms, p95 0 ms), 799228 in / 17616 out tokens (estimated), 0 model errors, live spend $0.0000 (the task ledger prices it at the seats' own tiers: $1.181685). Checks failed: recall, conversation_to_action.
- **full / eval-2** (bedrock: us.amazon.nova-lite-v1:0): champion team-2, fallback rate 0.159, 560 model calls (p50 4382 ms, p95 19320 ms), 33487501 in / 250793 out tokens (estimated), 90 model errors, live spend $0.9305 (the task ledger prices it at the seats' own tiers: $2.069443). Checks failed: conversation_to_action.
- **no_agenda_commitments / eval-2** (bedrock: us.amazon.nova-lite-v1:0): champion team-8, fallback rate 0.163, 542 model calls (p50 4265 ms, p95 21774 ms), 29002237 in / 229299 out tokens (estimated), 89 model errors, live spend $0.8676 (the task ledger prices it at the seats' own tiers: $1.795167). Checks failed: none.
- **persona_only / eval-2** (bedrock: us.amazon.nova-lite-v1:0): champion team-4, fallback rate 0.108, 536 model calls (p50 4264 ms, p95 9129 ms), 19147453 in / 199815 out tokens (estimated), 59 model errors, live spend $0.8986 (the task ledger prices it at the seats' own tiers: $1.19681). Checks failed: recall.
- **deterministic / eval-2** (fake: moonshot.kimi-k2-thinking, us.amazon.nova-lite-v1:0, us.amazon.nova-micro-v1:0, us.anthropic.claude-opus-5, us.anthropic.claude-sonnet-5): champion team-6, fallback rate 0, 509 model calls (p50 0 ms, p95 0 ms), 732303 in / 15540 out tokens (estimated), 0 model errors, live spend $0.0000 (the task ledger prices it at the seats' own tiers: $0.959948). Checks failed: recall, conversation_to_action.
