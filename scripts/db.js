/**
 * Database CLI — applies db/schema.sql without leaving the terminal.
 *
 *   npm run db:apply      apply db/schema.sql via psql
 *   npm run db:check      list the tables the API expects, and whether they exist
 *   npm run db:migration  regenerate supabase/migrations/ from db/schema.sql
 *   npm run db:setup      apply + seed
 *
 * Connection is resolved in this order:
 *   1. SUPABASE_DB_URL       — full postgres:// connection string
 *   2. SUPABASE_DB_PASSWORD  — combined with the project ref from SUPABASE_URL
 *
 * The password is passed to psql through PGPASSWORD, so it never lands in the
 * process list or your shell history.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaFile = path.join(root, 'db', 'schema.sql');

const EXPECTED_TABLES = [
  'users',
  'refresh_tokens',
  'problems',
  'enrollments',
  'daily_logs',
  'daily_assignments',
  'user_problems',
];

function fail(message, hint) {
  console.error(`\n  ${message}`);
  if (hint) console.error(`\n${hint}`);
  process.exit(1);
}

function projectRef() {
  if (!process.env.SUPABASE_URL) return null;
  try {
    return new URL(process.env.SUPABASE_URL).host.split('.')[0];
  } catch {
    return null;
  }
}

/** Returns { args, env } for psql — never the password itself. */
function connection() {
  if (process.env.SUPABASE_DB_URL) {
    return { args: [process.env.SUPABASE_DB_URL], env: {}, label: 'SUPABASE_DB_URL' };
  }

  const password = process.env.SUPABASE_DB_PASSWORD;
  const ref = projectRef();

  if (!password || !ref) {
    fail(
      'No database connection configured.',
      [
        '  Add ONE of these to Optimus-Code/.env (the file is gitignored):',
        '',
        '    SUPABASE_DB_PASSWORD=...   # Supabase → Project Settings → Database → Database password',
        '    SUPABASE_DB_URL=postgresql://...   # or the full connection string (use this for the pooler)',
        '',
        '  Then re-run this command.',
      ].join('\n'),
    );
  }

  return {
    args: ['-h', `db.${ref}.supabase.co`, '-p', '5432', '-U', 'postgres', '-d', 'postgres'],
    env: { PGPASSWORD: password },
    label: `db.${ref}.supabase.co`,
  };
}

function psql(extraArgs, { quiet = false } = {}) {
  const { args, env, label } = connection();

  const result = spawnSync('psql', [...args, '-v', 'ON_ERROR_STOP=1', ...extraArgs], {
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });

  if (result.error?.code === 'ENOENT') {
    fail(
      'psql is not installed.',
      '  macOS:  brew install libpq && brew link --force libpq\n  Debian: sudo apt install postgresql-client',
    );
  }

  return { ...result, label };
}

const commands = {
  apply() {
    if (!fs.existsSync(schemaFile)) fail(`Schema file not found: ${schemaFile}`);

    const { label } = connection();
    console.log(`applying db/schema.sql → ${label}\n`);

    const result = psql(['-f', schemaFile]);
    if (result.status !== 0) {
      fail(
        'Schema was not applied.',
        '  If auth failed, double-check SUPABASE_DB_PASSWORD.\n' +
          '  If the host could not be reached, your network may be IPv4-only — use the pooler\n' +
          '  connection string from the Supabase dashboard as SUPABASE_DB_URL instead.',
      );
    }

    console.log('\nschema applied. next: npm run seed');
  },

  check() {
    const query = `select table_name from information_schema.tables
                   where table_schema = 'public' and table_name = any('{${EXPECTED_TABLES.join(',')}}')`;

    const result = psql(['-tAc', query], { quiet: true });
    if (result.status !== 0) {
      fail('Could not query the database.', `  ${(result.stderr ?? '').trim()}`);
    }

    const present = new Set(result.stdout.trim().split('\n').filter(Boolean));
    for (const table of EXPECTED_TABLES) {
      console.log(`  ${present.has(table) ? '✓' : '✗'}  ${table}`);
    }

    const missing = EXPECTED_TABLES.filter((table) => !present.has(table));
    console.log(
      missing.length
        ? `\n${missing.length} table(s) missing — run: npm run db:apply`
        : '\nall tables present',
    );
    process.exitCode = missing.length ? 1 : 0;
  },

  /** Mirrors db/schema.sql into supabase/migrations so `supabase db push` works. */
  migration() {
    const dir = path.join(root, 'supabase', 'migrations');
    fs.mkdirSync(dir, { recursive: true });

    const dest = path.join(dir, '00000000000000_init.sql');
    const header = '-- Generated from db/schema.sql by `npm run db:migration`. Do not edit directly.\n\n';
    fs.writeFileSync(dest, header + fs.readFileSync(schemaFile, 'utf8'));

    const ref = projectRef();
    console.log(`wrote ${path.relative(root, dest)}`);
    console.log(`\nnext:\n  supabase link --project-ref ${ref ?? '<project-ref>'}\n  supabase db push`);
  },
};

const command = process.argv[2];
if (!commands[command]) {
  console.error(`usage: node scripts/db.js <${Object.keys(commands).join('|')}>`);
  process.exit(1);
}

commands[command]();
