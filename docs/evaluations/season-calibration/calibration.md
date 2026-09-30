Seeds cal-1, cal-2, cal-3, cal-4, cal-5; 17 league weeks of the 2025 archive; scripted model; configurations full, no_situation, no_attachments. Matched: a seed fixes the draft, the seats' personalities, difficulties, and archetypes, and the clock, so an ablation's change from `full` is taken seed by seed.

### Decisions and outcomes

| Metric | full | no_situation | no_attachments |
|---|---|---|---|
| Agent points for (mean per agent) | 1444.6 ± 30.7 (1485.3 / 1459.6 / 1430.2 / 1454.0 / 1394.1) | 1418.8 (Δ -25.9 ± 17.7; up 0, down 5 of 5) | 1459.4 (Δ +14.8 ± 27.5; up 4, down 1 of 5) |
| Agent wins (mean per agent) | 7.03 ± 0.33 (7.43 / 7.14 / 7.14 / 7 / 6.43) | 7.06 (Δ +0.03 ± 0.25; up 2, down 2 of 5) | 7.12 (Δ +0.09 ± 0.07; up 3, down 0 of 5) |
| Adds (churn) | 462 ± 28.4 (423 / 458 / 496 / 441 / 492) | 485 (Δ +23 ± 47.5; up 3, down 2 of 5) | 449.4 (Δ -12.6 ± 23.8; up 1, down 4 of 5) |
| Offers sent | 54 ± 5.51 (54 / 64 / 54 / 50 / 48) | 53.2 (Δ -0.80 ± 6.52; up 2, down 3 of 5) | 48.8 (Δ -5.20 ± 8.61; up 2, down 3 of 5) |
| Trades processed | 18.6 ± 3.50 (21 / 24 / 15 / 18 / 15) | 15.8 (Δ -2.80 ± 3.97; up 1, down 3 of 5) | 16.2 (Δ -2.40 ± 3.93; up 1, down 3 of 5) |
| Invalid action attempts | 0 ± 0 (0 / 0 / 0 / 0 / 0) | 0 (Δ +0 ± 0; up 0, down 0 of 5) | 0 (Δ +0 ± 0; up 0, down 0 of 5) |
| Agent messages | 597 ± 97.0 (754 / 626 / 593 / 456 / 556) | 596.4 (Δ -0.60 ± 26.6; up 2, down 3 of 5) | 589.8 (Δ -7.20 ± 11.3; up 1, down 4 of 5) |
| Model calls | 2658 ± 60.0 (2744 / 2690 / 2654 / 2562 / 2640) | 2673.2 (Δ +15.2 ± 24.8; up 3, down 2 of 5) | 2648 (Δ -10 ± 32.1; up 2, down 3 of 5) |
| Est. cost (USD, scripted) | 5.70 ± 1.51 (8.60 / 5.05 / 4.39 / 4.81 / 5.64) | 5.49 (Δ -0.21 ± 0.27; up 2, down 3 of 5) | 5.58 (Δ -0.12 ± 0.26; up 2, down 3 of 5) |

### Situational exposure (`full`, summed over seeds)

Agent tasks that read each state, and distinct agent-weeks in it.

| State | Tasks | Agent-weeks |
|---|---|---|
| baseline | 5228 | 146 |
| clinched | 1171 | 36 |
| contender | 3949 | 109 |
| bubble | 6202 | 169 |
| long_shot | 1006 | 27 |
| eliminated | 1951 | 57 |
| playoff_alive | 1858 | 56 |

Situation reads: 21365 (exact 4980, heuristic 11157, none 5228); label changes 139; tasks seeing a position short 4235, thin 21198; reads past the league's week (hindsight) 0.

Reasons read: in_playoff_position 8042, early_season 5228, thin_cushion 4093, comfortable_cushion 3949, outside_playoff_position 3115, awaiting_confirmation 3082, within_reach 2109, playoff_alive 1858, playoff_out 1670, final_stretch 1253, clinched 1171, far_behind 1006, eliminated 281.

### Attachments (`full`, summed over seeds)

Decisions an attachment touched: 672 (scout 599, answer 73); raised the bar 617 (mean +1.48 per raise, over run means); a pressing need waived it 55.

At season's end: 61 held, 239 departed; sources drafted 172, traded-for 131; revisions down 430, up 19; held but off the roster (must be 0) 0.

### Trade scouting by archetype (`full`, summed over seeds)

| Archetype | Agents | Check-ins | Shopped | Offers | Offers per shop |
|---|---|---|---|---|---|
| trade_happy | 5 | 1785 | 1298 | 85 | 0.07 |
| win_now | 5 | 1785 | 1048 | 49 | 0.05 |
| contrarian | 5 | 1785 | 965 | 32 | 0.03 |
| zero_rb | 4 | 1428 | 769 | 39 | 0.05 |
| analytics_only | 4 | 1428 | 760 | 12 | 0.02 |
| waiver_hawk | 3 | 1071 | 569 | 7 | 0.01 |
| balanced | 5 | 1785 | 900 | 36 | 0.04 |
| gut_feel_homer | 4 | 1428 | 676 | 10 | 0.01 |

Integrity: no invariant violation, event-loop failure, refused action, hindsight read, or stale attachment in any run.
