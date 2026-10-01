# ReachInbox Email Scheduler

Production-oriented email scheduling assignment with its Phase 0 foundation and Phase 1 relational domain model complete. The repository is a strict TypeScript pnpm monorepo with separate API, worker, and browser runtimes.

Campaign scheduling and queue consumption are not implemented yet. SMTP delivery, rate limiting, OAuth, Elasticsearch indexing, and email business APIs begin in later phases.

## Architecture

- `apps/api`: Express HTTP process with `GET /api/health`, the BullMQ producer, and Bull Board.
- `apps/worker`: independent background process with validated configuration and graceful shutdown hooks.
- `apps/web`: React, Vite, and Tailwind browser application.
- `packages/shared`: portable contracts, schemas, constants, and utilities shared by all runtimes.
- `prisma`: PostgreSQL/Prisma relational domain schema, migration history, and database integration tests.
- `elastic`: boundary reserved for future Elasticsearch assets such as mappings.
- `scripts`: operational scripts added as later phases require them.
- `context`: read-only product and architecture guidance.

PostgreSQL will be the source of truth, Redis/BullMQ the durable execution layer, and Elasticsearch a searchable projection. The API and worker remain separate processes so they can later be deployed as a Render web service and Render background worker. Production Redis is expected to use an Upstash Redis TCP URL; Elasticsearch is expected to use Elastic Cloud.

Phase 2 provides queue infrastructure only: it does not yet schedule campaigns or consume jobs.

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

## Environment model

Runtime configuration is parsed with Zod from an explicit input object. Application code consumes validated configuration rather than reading scattered `process.env` values. Infrastructure URLs and local safety settings are required. Credentials for future OAuth, SMTP, and managed Elasticsearch features are represented but optional until those features are implemented; production-specific validation will be tightened alongside each feature.

## Phase status

Phase 0 repository and runtime foundations are complete. Phase 1 relational domain schema, migration history, and PostgreSQL invariant tests are complete. Phase 2 BullMQ producer infrastructure and Bull Board are complete. Campaign scheduling, queue consumption, persistence reconciliation, search, OAuth, SMTP delivery, and the assignment dashboard remain pending.
