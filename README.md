# ReachInbox Email Scheduler

Production-oriented email scheduling assignment with its Phase 0 foundation and Phase 1 relational domain model complete. The repository is a strict TypeScript pnpm monorepo with separate API, worker, and browser runtimes.

The scheduling application service is exposed through an authenticated-principal HTTP boundary. Real Google authentication, queue consumption, SMTP delivery, rate limiting, Elasticsearch indexing, and read APIs begin in later phases.

## Architecture

- `apps/api`: Express HTTP process with health and campaign scheduling routes, the BullMQ producer, and Bull Board.
- `apps/worker`: independent background process with validated configuration and graceful shutdown hooks.
- `apps/web`: React, Vite, and Tailwind browser application.
- `packages/shared`: portable contracts, schemas, constants, and utilities shared by all runtimes.
- `prisma`: PostgreSQL/Prisma relational domain schema, migration history, and database integration tests.
- `elastic`: boundary reserved for future Elasticsearch assets such as mappings.
- `scripts`: operational scripts added as later phases require them.
- `context`: read-only product and architecture guidance.

PostgreSQL will be the source of truth, Redis/BullMQ the durable execution layer, and Elasticsearch a searchable projection. The API and worker remain separate processes so they can later be deployed as a Render web service and Render background worker. Production Redis is expected to use an Upstash Redis TCP URL; Elasticsearch is expected to use Elastic Cloud.

Phase 2 provides queue infrastructure; Phase 3 provides the scheduling service and HTTP boundary. Jobs are not consumed yet.

## Prerequisites

- Node.js 22.16.0 (see `.nvmrc`)
- pnpm 10.15.1 through Corepack
- Docker Desktop with Docker Compose v2

## Local setup

```bash
corepack enable
pnpm install
cp .env.example .env
pnpm prisma:generate
pnpm infra:up
```

The checked-in example contains safe local infrastructure URLs and development-only secret placeholders. OAuth and Ethereal values remain empty because those features are not implemented yet. Never commit `.env` or real credentials.

## Development commands

Run each process in its own terminal:

```bash
pnpm dev:api
pnpm dev:worker
pnpm dev:web
```

Or run all three together:

```bash
pnpm dev
```

Default local URLs:

- API health: `http://localhost:4000/api/health`
- Web: `http://localhost:5173`
- PostgreSQL: `localhost:5432`
- Redis: `localhost:6379`
- Elasticsearch: `http://localhost:9200`

The API and worker load `.env` from the repository root. Stop either process with `Ctrl+C`; both runtime entrypoints handle `SIGINT` and `SIGTERM` and have a central place to register future resource cleanup.

## Local infrastructure

```bash
pnpm infra:up
pnpm infra:logs
pnpm infra:down
```

Docker Compose starts only PostgreSQL, Redis, and Elasticsearch. PostgreSQL and Redis use named volumes. Redis enables AOF with `appendfsync everysec` and uses `noeviction`, matching the future BullMQ durability requirements. Elasticsearch runs as a single local node with security disabled only for local development.

To remove infrastructure data as well as containers, explicitly run `docker compose down --volumes`. The normal `infra:down` command preserves data.

## Quality and tests

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:run
pnpm test:coverage
pnpm build
pnpm format:check
```

Vitest runs Node projects for API, worker, and shared code, and jsdom for the web application. The API health test uses Supertest without opening a port.

## Database and Prisma

```bash
pnpm prisma:validate
pnpm prisma:generate
pnpm db:migrate
```

The Prisma schema defines the User, Sender, Campaign, Email, and SlackIntegration source-of-truth models. Migration history lives in `prisma/migrations`; use migrations rather than `db push`.

Fresh PostgreSQL volumes create both `reachinbox` and isolated `reachinbox_test` databases. If the PostgreSQL volume predates Phase 1, create the test database once:

```bash
docker compose exec postgres createdb -U postgres reachinbox_test
```

Database integration tests never use `DATABASE_URL`. They use `TEST_DATABASE_URL`, verify it differs from the development URL, and refuse database names that do not end in `_test` or `_rebuild`.

```bash
pnpm test:db
```

## Queue foundation

The API owns one BullMQ producer for the `email-send` queue. Jobs are named `send-email`, contain only `{ emailId }`, and use `email-<uuid>` IDs. Future schedules use BullMQ delays; timestamps at or before enqueue time use zero delay. Assignment-scale bulk insertion uses one `addBulk()` operation rather than sequential Redis calls.

Run the real-Redis queue tests with infrastructure running:

```bash
pnpm infra:up
pnpm test:queue
```

Start the API and open Bull Board at `http://localhost:4000/admin/queues`. The board is intentionally unauthenticated for local development; production protection is deferred to the authentication phase. No BullMQ Worker is started in Phase 2, so queued jobs remain waiting or delayed.

BullMQ custom IDs prevent duplicate insertion only while the prior queue job exists. PostgreSQL status remains the future business idempotency boundary. The DB-to-Redis failure window is intentionally deferred to startup reconciliation.

## Scheduling application service

Phase 3 accepts `multipart/form-data` at `POST /api/v1/campaigns`. The route requires an authentication middleware principal and `Idempotency-Key`, parses an in-memory CSV/TXT lead file up to 5 MB, and passes normalized scheduling intent to `CampaignScheduler`. The service verifies active sender ownership, plans ordered timestamps, atomically creates Campaign and Email rows, and then bulk-enqueues deterministic jobs.

Google OAuth is not implemented yet. For manual local testing only, set `DEV_AUTH_USER_ID` to the UUID of an existing local User. This adapter is disabled in production and never accepts caller-supplied identity. With a matching active Sender UUID and a local `leads.csv`:

```bash
curl --fail-with-body http://localhost:4000/api/v1/campaigns \
  -H 'Idempotency-Key: manual-schedule-1' \
  -F 'subject=Manual campaign' \
  -F 'body=Hello from the local API' \
  -F 'senderId=<ACTIVE_SENDER_UUID>' \
  -F 'startAt=2030-01-01T10:00:00.000Z' \
  -F 'delayMs=2000' \
  -F 'hourlyLimit=200' \
  -F 'file=@leads.csv;type=text/csv'
```

Inspect Campaign and Email rows with Prisma Studio or `psql`, and inspect jobs at `http://localhost:4000/admin/queues`. Reusing the same key and semantic request returns the same campaign; changing the request while reusing the key returns `409 Conflict`.

Initial placement uses `max(startAt, now)`, the configured campaign delay, and fixed UTC-hour windows. This planning reduces predictable bursts but does not replace the future Redis-backed cross-campaign runtime limiter.

Run the pure and real PostgreSQL/Redis scheduling tests with:

```bash
pnpm infra:up
pnpm test:scheduling
```

PostgreSQL commits before Redis enqueue. An idempotent client retry can restore missing jobs after an enqueue error; startup reconciliation remains necessary for a crash where no client retries.

## Environment model

Runtime configuration is parsed with Zod from an explicit input object. Application code consumes validated configuration rather than reading scattered `process.env` values. Infrastructure URLs and local safety settings are required. Credentials for future OAuth, SMTP, and managed Elasticsearch features are represented but optional until those features are implemented; production-specific validation will be tightened alongside each feature.

## Phase status

Phase 0 repository and runtime foundations, Phase 1 relational model, Phase 2 BullMQ producer/Bull Board, and the Phase 3 scheduling service plus HTTP API are complete. Queue consumption, persistence reconciliation, search, OAuth, SMTP delivery, and the assignment dashboard remain pending.
