import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MODEL_CATALOG } from '@fantasy/core';
import { describe, expect, it } from 'vitest';
import { MEMORY_EVENTS } from '../src/memory.js';
import { TRIGGER_RULES } from '../src/router.js';

/** infra/template.yaml must grant exactly the catalog's models and wire both agent handlers. */
const template = readFileSync(
  fileURLToPath(new URL('../../../infra/template.yaml', import.meta.url)),
  'utf8'
);

function section(start: string, end: string): string {
  const from = template.indexOf(start);
  const to = template.indexOf(end, from);
  expect(from, start).toBeGreaterThan(-1);
  return template.slice(from, to);
}

describe('agent infrastructure', () => {
  const policy = section('        # Model access, scoped to the catalog', '# End of agent Bedrock access');

  it('grants every catalog model and inference profile', () => {
    for (const m of MODEL_CATALOG) {
      expect(policy, m.key).toContain(`foundation-model/${m.foundationModelId}\n`);
      if (m.inferenceProfile) expect(policy, m.key).toContain(`inference-profile/${m.bedrockId}\n`);
    }
  });

  it('grants nothing outside the catalog', () => {
    const arns = [...policy.matchAll(/(?:foundation-model|inference-profile)\/(\S+)/g)].map((m) => m[1]);
    const allowed = new Set(MODEL_CATALOG.flatMap((m) => [m.bedrockId, m.foundationModelId]));
    for (const id of arns) expect(allowed.has(id as string), id).toBe(true);
    expect(policy).not.toMatch(/Resource: '\*'/);
  });

  it('routes every trigger event to the router and requested tasks to the task handler', () => {
    const router = section('  AgentRouterFunction:', '  AgentTaskFunction:');
    expect(router).toContain('Handler: agent-router.handler');
    // Least privilege: Get, Put, and Query only (no DynamoDBCrudPolicy).
    expect(router).not.toContain('DynamoDBCrudPolicy');
    expect([...router.matchAll(/dynamodb:(\w+)/g)].map((m) => m[1])).toEqual(['GetItem', 'PutItem', 'Query']);
    for (const detailType of [...Object.keys(TRIGGER_RULES), ...MEMORY_EVENTS]) {
      expect(router).toContain(`- ${detailType}\n`);
    }
    const task = section('  AgentTaskFunction:', 'End of agent platform section');
    expect(task).toContain('Handler: agent-task.handler');
    expect(task).toContain('- Agent Action Requested');
    // The draft report card grader runs in the same function, for its model access.
    expect(task).toContain('- Draft Completed');
    expect(task).toContain(policy);
    expect(template).not.toContain('AWS::IAM::ManagedPolicy');
    expect(task).toContain('AGENT_KILL_SWITCH_PARAM: !Ref AgentKillSwitchParameter');
  });

  it('gives the API the spend guard settings and read access to the kill switch', () => {
    const api = section('  ApiFunction:', '  AgentKillSwitchParameter:');
    expect(api).toContain('LEAGUE_QUOTA: !Ref LeagueQuota');
    expect(api).toContain('LEAGUE_QUOTA_ADMINS: !Ref LeagueQuotaAdmins');
    expect(api).toContain('AGENT_KILL_SWITCH_PARAM: !Ref AgentKillSwitchParameter');
    expect(api).toContain('parameter/${AWS::StackName}/agents/kill-switch');
  });
});
