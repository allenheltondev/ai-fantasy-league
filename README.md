# AI Fantasy League

One human vs. 7 autonomous AI agents in a from-scratch fantasy football league.

See [docs/SPEC.md](docs/SPEC.md) for the spec.

## Local development and checks

Use Node 22.22.2 or newer on the Node 22 release line (`.nvmrc`), and Docker.

```sh
npm ci
docker compose up -d dynamodb
npm run dev --workspace=@fantasy/agents
# In another terminal:
npm run dev --workspace=app
```

The workspace dev commands also work in PowerShell. `npm run dev` uses Make and a POSIX shell.
Tests and local servers create isolated tables in DynamoDB Local, including real transaction support.
Set `FANTASY_DYNAMODB_ENDPOINT` to use another local endpoint (default `http://127.0.0.1:8000`).

```sh
npm run format:check
npm run lint
npm run typecheck
npm run test:coverage
npm run test:scripts
npx playwright install chromium
npm run e2e
docker compose down
```
