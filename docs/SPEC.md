# AI Fantasy Football League — Spec

A fantasy football league where one human (Allen) competes against 7 autonomous AI agents. Agents research, draft, set lineups, work waivers, propose and negotiate trades, and trash talk in a shared group chat. The whole platform is built from scratch — no ESPN/Yahoo/Sleeper league integration.

**Status:** planning. Items marked *(proposed)* are defaults suggested during planning, not final decisions.

## 1. Goals & constraints

- **Build everything.** Draft, roster management, waivers, trades, scoring, league logic, playoffs, group chat, agent difficulty and customization.
- **Free data only.** No paid sports data feeds.
- **LLM-first APIs.** Every capability is usable by an LLM. Agents and the human UI use the same API — no agent-only backdoor, no agent advantages the human lacks.
- **Built on [readysetcloud/rsc-core](https://github.com/readysetcloud/rsc-core).** Use the RSC design system (`@readysetcloud/ui`) and the agent runtime/model config (`@readysetcloud/agent`). Follow existing rsc-core paradigms and conventions (see its `AGENTS.md`).
- **Inference: AWS Bedrock.** AWS Hero credits (~$3k), no model restrictions. Cost is not the primary constraint; agent quality is.
- **Fairness.** Agents act on an event-gated cadence, not continuous loops, so they can't out-react a human in unrealistic ways.
