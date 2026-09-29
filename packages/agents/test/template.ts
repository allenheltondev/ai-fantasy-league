import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** infra/template.yaml, as text. */
export const template = readFileSync(
  fileURLToPath(new URL('../../../infra/template.yaml', import.meta.url)),
  'utf8'
);

/** The detail types the router Lambda's EventBridge rule delivers (what production ingests). */
export function routerRuleEvents(): string[] {
  const from = template.indexOf('  AgentRouterFunction:');
  const router = template.slice(from, template.indexOf('  AgentTaskFunction:', from));
  const events: string[] = [];
  for (const line of router.slice(router.indexOf('detail-type:')).split('\n').slice(1)) {
    const item = /^ {16}- (.+)$/.exec(line);
    if (item !== null) events.push(item[1] as string);
    else if (!/^ {16}#/.test(line)) break;
  }
  return events;
}
