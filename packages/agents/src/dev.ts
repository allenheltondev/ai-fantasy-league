/**
 * The `npm run dev` API server with agents: the local server (`@fantasy/server/local`) plus its
 * in-process event loop, so agents pick on their turn, the pick clock autopicks, system messages
 * post, and the season jobs run, all on the scripted fake model. The server package cannot import
 * the agents package, so this entrypoint lives here.
 */
import { pathToFileURL } from 'node:url';
import { startLocalServer, type LocalServer, type LocalServerOptions } from '@fantasy/server/local';
import { ScriptedModelClient } from './fake-model.js';
import { agentSubscribers, inProcessAgentDeps } from './loop.js';

export function startDevServer(options: Omit<LocalServerOptions, 'eventLoop'> = {}): Promise<LocalServer> {
  return startLocalServer({
    ...options,
    eventLoop: {
      subscribers: (services) => agentSubscribers(inProcessAgentDeps(services, new ScriptedModelClient()))
    }
  });
}

/* v8 ignore start -- process entrypoint */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const local = await startDevServer({ port: Number(process.env.PORT ?? 3001) });
  process.stdout.write(`Fantasy API with in-process agents listening on ${local.url}/api/v1\n`);
}
/* v8 ignore stop */
