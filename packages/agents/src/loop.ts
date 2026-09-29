import { EVENT_DETAIL_SCHEMAS, registry, type EventSubscriber, type Services } from '@fantasy/server';

const DraftCompletedSchema = EVENT_DETAIL_SCHEMAS['Draft Completed'];
import { gradeDraft } from './draft-report.js';
import { AgentActionRequestedSchema } from './events.js';
import { OFF_SWITCH, type KillSwitch } from './kill-switch.js';
import type { ModelClient } from './model.js';
import { TRIGGER_RULES, leagueRosterIndex, routeEvent, type RouterDeps } from './router.js';
import { runAgentAction, type RunnerDeps } from './runner.js';
import { defaultTaskKinds } from './tasks/index.js';

/**
 * The agent router, task runner, and draft report grader as event-loop subscribers (`EventLoop` in `@fantasy/server`),
 * calling the same functions as their Lambdas (`lambda/router.ts`, `lambda/task.ts`). The season
 * replay simulator and the local dev server use them to run agents in process.
 */
export function agentSubscribers(deps: { router: RouterDeps; runner: RunnerDeps }): EventSubscriber[] {
  return [
    {
      name: 'agent-router',
      detailTypes: Object.keys(TRIGGER_RULES),
      handle: (event) => routeEvent(deps.router, event)
    },
    {
      name: 'agent-task',
      detailTypes: ['Agent Action Requested'],
      handle: (event) => runAgentAction(deps.runner, AgentActionRequestedSchema.parse(event.detail))
    },
    {
      name: 'draft-report',
      detailTypes: ['Draft Completed'],
      handle: (event) => gradeDraft(deps.runner, DraftCompletedSchema.parse(event.detail).leagueId)
    }
  ];
}

/** Router and runner dependencies for in-process agents, wired like the Lambdas. */
export function inProcessAgentDeps(
  services: Services,
  model: ModelClient,
  options: { killSwitch?: KillSwitch; modelTimeoutMs?: number; responseDelays?: boolean } = {}
): { router: RouterDeps; runner: RunnerDeps } {
  return {
    // Response delays stay off in process (dev server, e2e, the simulator) unless asked for.
    router: {
      services,
      kinds: defaultTaskKinds,
      rosterIndex: leagueRosterIndex(services),
      responseDelays: options.responseDelays ?? false
    },
    runner: {
      registry,
      services,
      kinds: defaultTaskKinds,
      model,
      killSwitch: options.killSwitch ?? OFF_SWITCH,
      ...(options.modelTimeoutMs === undefined ? {} : { modelTimeoutMs: options.modelTimeoutMs })
    }
  };
}
