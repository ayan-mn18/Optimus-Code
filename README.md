# Optimus Code — API

Backend for **Optimus Code**, a daily DSA and System Design practice platform.
The DSA catalogue comes from the Striver SDE and A2Z sheets. LLD and HLD metadata
comes from [Code With Aryan](https://codewitharyan.com/system-design) with source attribution.

Each user chooses separate DSA, LLD, and HLD goals. A day turns green only when every
category quota is complete. System Design completion requires passing a ten-question
Optimus assessment; LLD attempts may include isolated coding tests.

Frontend lives in [Optimus-Code-UI](https://github.com/ayan-mn18/Optimus-Code-UI).

## Stack

| Piece      | Choice                                        |
| ---------- | --------------------------------------------- |
| Runtime    | Node 20+, Express 4 (ESM)                     |
| Database   | Supabase (Postgres) via `@supabase/supabase-js` |
| Auth       | JWT sessions, bcrypt passwords, Google Identity Services |
| Validation | zod                                           |
| Email      | Brevo transactional email API                 |
| Billing    | Dodo Payments hosted subscriptions            |
| Hardening  | helmet, cors allowlist, rate limits, isolated code execution |

## Getting started

```bash
cp .env.example .env      # fill in Supabase URL + service role key, and two JWT secrets
npm install
```

For email delivery, verify a Brevo sender and set `BREVO_API_KEY`, `EMAIL_FROM`,
`APP_URL`, and `EMAIL_DELIVERY_ENABLED=true`. Delivery stays disabled otherwise.

Then create the schema and load the problem catalogue — all from the CLI:

```bash
npm run db:setup
```

That runs `db:apply` (pushes `db/schema.sql` through `psql`) followed by `seed`. It needs
`SUPABASE_DB_PASSWORD` in `.env` — Supabase → Project Settings → Database → Database
password. On an IPv4-only network use the pooler connection string as `SUPABASE_DB_URL`
instead.

### Database commands

| Command                        | What it does                                                        |
| ------------------------------ | ------------------------------------------------------------------- |
| `npm run db:apply`             | Applies `db/schema.sql` via `psql`                                  |
| `npm run db:check`             | Prints which expected tables exist                                 |
| `npm run db:migration`         | Mirrors the schema into `supabase/migrations/`                      |
| `npm run db:setup`             | `db:apply` + `seed`                                                 |
| `npm run seed`                 | Upserts DSA, LLD, and HLD catalogues by `(kind, slug)`              |
| `npm run scrape`               | Refreshes the Striver DSA snapshot                                  |
| `npm run scrape:system-design` | Refreshes 73 LLD and 205 HLD items                                  |
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

### Transactional email

Brevo sends one-time waitlist invitations, account-ready messages, milestone celebrations,
red-day recaps, and late-day streak warnings. Invite tokens are random, stored only as
SHA-256 hashes, expire after seven days by default, and are consumed in the same database
transaction that creates the account.

Use a verified sender. Passwords are chosen inside the application and never emailed.

### Refreshing catalogues

`data/problems.json` contains DSA. `data/system-design.json` contains attributed LLD/HLD metadata.

```bash
npm run scrape
npm run scrape:system-design
```

## Data model

| Table               | Purpose                                                        |
| ------------------- | -------------------------------------------------------------- |
| `users`                  | Password or Google account, timezone, standings                 |
| `refresh_tokens`         | Hashed, rotating, revocable                                     |
| `problems`               | Unified DSA, LLD, and HLD catalogue                              |
| `enrollments`            | Separate DSA, LLD, and HLD daily goals                          |
| `daily_logs`             | Per-category snapshots and daily status                         |
| `daily_assignments`      | Stored daily assignments and DSA extra rounds                   |
| `user_problems`          | Verified solve state                                              |
| `assessment_attempts`    | Immutable Optimus question sets and result state                |
| `assessment_answers`     | Answers, rubric feedback, and test results                      |
| `subscriptions`          | Dodo subscription lifecycle                                     |
| `payment_webhook_events` | Idempotent signed webhook receipts                              |
| `milestone_recaps`       | Immutable milestone analytics                                   |
| `waitlist`               | Public signups                                                   |
| `account_invites`        | Hashed, expiring invitation tokens                              |

Standings (`current_streak`, `green_days`, `total_solved`, `last_streak_day`) are denormalised
onto `users` whenever a streak is recomputed, so the leaderboard does not replay every user's
log history. `freezes_used` is the only stored half of the freeze balance — the earned count is
derived from green days, so an award can never double-fire.

RLS is enabled on every table. The API holds the service-role key and authorizes each
request itself; only `problems` is readable by anon.

## How a day works

1. First request settles older active days using each saved category quota.
2. Today's DSA, LLD, and HLD sets are generated once and stored.
3. Picks favor unsolved work, old backlog, topic diversity, and weak coverage.
4. DSA uses direct solve state. LLD and HLD only complete after Optimus passes.
5. The day turns green only when every category quota is complete.
6. Once green, users may request DSA-only bonus rounds.

Day boundaries use the user's own timezone, stored on their profile.

### Streak freezes

One freeze is earned per 10 green days, capped at 3 banked. When a day closes short and a
freeze is available it is spent automatically: the day is recorded as `frozen` rather than
`missed` and the streak survives. A frozen day holds the streak but does not lengthen it, and
its unsolved problems still return to the pool like any red day.

## API

All authenticated routes take `Authorization: Bearer <accessToken>`.

### Auth — `/api/auth`

| Method | Path       | Body                                | Notes                          |
| ------ | ---------- | ----------------------------------- | ------------------------------ |
| POST   | `/login`   | `email, password`                   | Password session               |
| POST   | `/google`  | `credential, timezone`              | Google sign-in or signup       |
| POST   | `/refresh` | `refreshToken`                      | Rotates the refresh token      |
| POST   | `/logout`  | —                                   | Revokes all refresh tokens     |
| GET    | `/me`      | —                                   | Current user + enrollment      |
| PATCH  | `/me`      | `name?, timezone?, showOnLeaderboard?` | Update profile              |

### Challenge — `/api/challenge`

| Method | Path                 | Notes                                              |
| ------ | -------------------- | -------------------------------------------------- |
| GET    | `/`                  | Enrollment + streak                                |
| POST   | `/enroll`            | Join with `goals: { DSA, LLD, HLD }`               |
| PATCH  | `/goals`             | Update future daily goals                          |
| GET    | `/today`             | Mixed assignments and per-category progress       |
| POST   | `/extend`            | Deal a DSA bonus set after completing the day      |
| POST   | `/solve/:problemId`  | Mark DSA solved                                    |
| DELETE | `/solve/:problemId`  | Undo a DSA solve                                   |

### Milestones — `/api/milestones`

| Method | Path                   | Notes                                      |
| ------ | ---------------------- | ------------------------------------------ |
| GET    | `/pending`             | Latest unviewed 50-solve milestone recap   |
| POST   | `/:milestone/viewed`   | Mark a milestone celebration as viewed     |

### Waitlist — `/api/waitlist`

Joining sends one active account invitation when Brevo is configured. Repeated submissions
do not duplicate active invites.

| Method | Path | Body                       | Notes                                          |
| ------ | ---- | -------------------------- | ---------------------------------------------- |
| GET    | `/`  | —                          | Total signups, for the landing-page counter     |
| POST   | `/`  | `email, name?, referrer?`  | Adds the email and sends a one-time invite      |
 
### Invitations — `/api/invites`

| Method | Path       | Body                              | Notes                              |
| ------ | ---------- | --------------------------------- | ---------------------------------- |
| POST   | `/inspect` | `token`                           | Validates an unexpired invite       |
| POST   | `/accept`  | `token, name, password, timezone` | Atomically creates the user account |

### Leaderboard — `/api/leaderboard`

| Method | Path | Query                                    | Notes                                        |
| ------ | ---- | ---------------------------------------- | -------------------------------------------- |
| GET    | `/`  | `metric=streak\|solved\|consistency`     | Top 50 plus the caller's own rank             |

A stored streak only counts while it is still alive — if the last streak-holding day is older
than yesterday it reads as zero. Users who set `show_on_leaderboard` to false drop off the
board but still get their own standing back.

### Dashboard — `/api/dashboard`

| Method | Path        | Notes                                                        |
| ------ | ----------- | ------------------------------------------------------------ |
| GET    | `/overview` | Totals, streak, topic mastery, difficulty split, 182-day heatmap |
| GET    | `/recap`    | `weeksAgo` (0–52) — a week's totals, daily bars, topics, and the change on the week before |
| GET    | `/problems` | Filter by `topic`, `difficulty`, `status`, `search`, paginated |
| GET    | `/topics`   | Topic list with problem counts                               |

### System Design — `/api/system-design`

`GET /` lists LLD or HLD with topic, difficulty, text, and solve filters. `GET /:problemId`
returns one attributed catalogue item.

### Optimus — `/api/assessments`

Create or resume an attempt, autosave answers, run visible code tests, then submit once.
The server removes rubrics and hidden tests from every client response.

### Billing — `/api/billing`

`GET /pricing` is public. Authenticated users create Dodo checkout sessions and read their
subscription. `/webhook` verifies Standard Webhooks signatures and processes events idempotently.

## Environment

See `.env.example` for Google, Brevo, LLM, Judge0, and Dodo variables. Provider keys remain
server-only. The frontend receives only `VITE_GOOGLE_CLIENT_ID`.

## Licence

MIT
