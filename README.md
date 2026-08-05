# Optimus Code — API

Backend for **Optimus Code**, a daily DSA challenge platform built on the
[Striver SDE Sheet](https://takeuforward.org/dsa/strivers-sde-sheet-top-coding-interview-problems).

Every enrolled developer gets **5 problems a day**, each from a different topic. Clear all
five and the day turns green. Fall short and the day is marked **red** — the problems you
skipped drop back into the pool and resurface on a later day. Solve more than five and the
extras count as bonus.

Frontend lives in [Optimus-Code-UI](https://github.com/ayan-mn18/Optimus-Code-UI).

## Stack

| Piece      | Choice                                        |
| ---------- | --------------------------------------------- |
| Runtime    | Node 20+, Express 4 (ESM)                     |
| Database   | Supabase (Postgres) via `@supabase/supabase-js` |
| Auth       | Own JWT — bcrypt hashes, rotating refresh tokens |
| Validation | zod                                           |
| Hardening  | helmet, cors allowlist, express-rate-limit, compression |

## Getting started

```bash
cp .env.example .env      # fill in Supabase URL + service role key, and two JWT secrets
npm install
```

Then create the schema and load the problem catalogue — all from the CLI:

```bash
npm run db:setup
```

That runs `db:apply` (pushes `db/schema.sql` through `psql`) followed by `seed`. It needs
`SUPABASE_DB_PASSWORD` in `.env` — Supabase → Project Settings → Database → Database
password. On an IPv4-only network use the pooler connection string as `SUPABASE_DB_URL`
instead.

### Database commands

| Command                | What it does                                                        |
| ---------------------- | ------------------------------------------------------------------- |
| `npm run db:apply`     | Applies `db/schema.sql` via `psql` (idempotent — safe to re-run)     |
| `npm run db:check`     | Prints which expected tables exist; exits non-zero if any are missing |
| `npm run db:migration` | Mirrors the schema into `supabase/migrations/` for `supabase db push` |
| `npm run db:setup`     | `db:apply` + `seed`                                                  |
| `npm run seed`         | Upserts the 191 problems (keyed on `slug`)                           |

`psql` is required for `db:apply` / `db:check` (`brew install libpq && brew link --force libpq`).
The password is passed through `PGPASSWORD`, so it never appears in the process list or your
shell history.

**Prefer the Supabase CLI?** `npm run db:migration` writes the schema into
`supabase/migrations/`, after which the usual flow works and no database password is needed:

```bash
supabase link --project-ref <your-project-ref>
supabase db push
npm run seed
```

Either way you can also just paste `db/schema.sql` into the Supabase SQL editor.

Start the API:

```bash
npm run dev
```

It listens on `http://localhost:4000`. `GET /health` is a liveness check.

### Refreshing the problem catalogue

`data/problems.json` is generated. To re-scrape the sheet:

```bash
npm run scrape
```

## Data model

| Table               | Purpose                                                        |
| ------------------- | -------------------------------------------------------------- |
| `users`             | Account, bcrypt password hash, timezone                         |
| `refresh_tokens`    | Hashed, rotating, revocable                                     |
| `problems`          | 191 problems across 13 topics with LeetCode / YouTube / article links |
| `enrollments`       | One per user — daily target, start date                         |
| `daily_logs`        | One row per user per day: `active` \| `complete` \| `missed`    |
| `daily_assignments` | The problems handed out on a day, with a `carried_over` flag    |
| `user_problems`     | Solve state, one row per (user, problem), `is_bonus` for extras |

RLS is enabled on every table. The API holds the service-role key and authorizes each
request itself; only `problems` is readable by anon.

## How a day works

1. First request of the day settles any day that ended while still `active` — target met
   becomes `complete`, otherwise `missed`.
2. Today's set is generated once and stored. Up to 60% of the slots go to problems carried
   over from red days (oldest first); the rest are fresh, biased toward the topics you have
   solved least.
3. Each pick comes from a different topic. If fewer distinct topics remain than the target,
   the rule relaxes rather than handing out a short day.
4. Solving an assigned problem bumps `solved_count`; hitting the target flips the day green.
   Anything solved beyond the set is counted as bonus.

Day boundaries use the user's own timezone, stored on their profile.

## API

All authenticated routes take `Authorization: Bearer <accessToken>`.

### Auth — `/api/auth`

| Method | Path       | Body                                | Notes                          |
| ------ | ---------- | ----------------------------------- | ------------------------------ |
| POST   | `/signup`  | `name, email, password, timezone`   | Returns session + tokens       |
| POST   | `/login`   | `email, password`                   | Returns session + tokens       |
| POST   | `/refresh` | `refreshToken`                      | Rotates the refresh token      |
| POST   | `/logout`  | —                                   | Revokes all refresh tokens     |
| GET    | `/me`      | —                                   | Current user + enrollment      |
| PATCH  | `/me`      | `name?, timezone?`                  | Update profile                 |

### Challenge — `/api/challenge`

| Method | Path                 | Notes                                              |
| ------ | -------------------- | -------------------------------------------------- |
| GET    | `/`                  | Enrollment + streak                                |
| POST   | `/enroll`            | `dailyTarget?` (default 5) — join the challenge     |
| GET    | `/today`             | Today's set, progress, streak, days just closed out |
| POST   | `/solve/:problemId`  | `timeSpentMin?, notes?` — mark solved               |
| DELETE | `/solve/:problemId`  | Undo a solve                                        |

### Dashboard — `/api/dashboard`

| Method | Path        | Notes                                                        |
| ------ | ----------- | ------------------------------------------------------------ |
| GET    | `/overview` | Totals, streak, topic mastery, difficulty split, 182-day heatmap |
| GET    | `/problems` | Filter by `topic`, `difficulty`, `status`, `search`, paginated |
| GET    | `/topics`   | Topic list with problem counts                               |

## Environment

| Variable                    | Default                 |
| --------------------------- | ----------------------- |
| `PORT`                      | `4000`                  |
| `NODE_ENV`                  | `development`           |
| `CORS_ORIGIN`               | `http://localhost:5173` (comma-separated) |
| `SUPABASE_URL`              | required                |
| `SUPABASE_SERVICE_ROLE_KEY` | required                |
| `JWT_ACCESS_SECRET`         | required                |
| `JWT_REFRESH_SECRET`        | required                |
| `JWT_ACCESS_TTL`            | `15m`                   |
| `JWT_REFRESH_TTL`           | `30d`                   |
| `DAILY_TARGET`              | `5`                     |

## Licence

MIT
