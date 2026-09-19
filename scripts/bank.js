#!/usr/bin/env node
/**
 * Reads the Optimus question bank from the command line.
 *
 * Nothing here writes. The bank is filled by real attempts — a question is
 * generated because somebody sat the problem, and kept on the way past — so
 * there is no warming job to run and no `fill` command to run it. What is left
 * is the thing that always mattered: reading what the model actually wrote
 * before deciding whether it is good enough to keep asking.
 *
 *   node scripts/bank.js status --kind LLD
 *   node scripts/bank.js status --kind HLD --problems 40
 *   node scripts/bank.js show <questionId>
 */
import { db, unwrap } from '../src/lib/supabase.js';
import { bankInventory } from '../src/services/assessment/bank.js';

const [command = 'status', ...rest] = process.argv.slice(2);
const flags = Object.fromEntries(
  rest.filter((token) => token.startsWith('--')).map((token, index, all) => {
    const name = token.replace(/^--/, '');
    const next = rest[rest.indexOf(all[index]) + 1];
    return [name, next && !next.startsWith('--') ? next : true];
  }),
);
const positional = rest.filter((token) => !token.startsWith('--'));

const kind = (flags.kind ?? 'LLD').toUpperCase();
const problemLimit = Number(flags.problems ?? 20);

async function problems() {
  let query = db
    .from('problems')
    .select('id, title, kind, coding_enabled')
    .eq('kind', kind)
    .eq('assessment_enabled', true);
  // Half the LLD catalogue is explainer pages, which carry no coding bank at
  // all — listing them alongside the interview problems just adds noise.
  if (!flags.all) query = query.eq('coding_enabled', true);
  if (flags.problem) query = query.ilike('title', `%${flags.problem}%`);

  const rows = unwrap(await query.order('order_index').limit(problemLimit), 'load problems');
  if (!rows.length) throw new Error(`No matching ${kind} problems with assessments enabled`);
  return rows;
}

if (command === 'status') {
  const rows = await problems();
  const inventory = await bankInventory(rows.map((row) => row.id));
  let banked = 0;

  for (const problem of rows) {
    const depth = inventory.get(problem.id) ?? {};
    banked += Object.values(depth).reduce((sum, count) => sum + count, 0);
    const summary = Object.entries(depth).map(([type, count]) => `${type}=${count}`).join(' ') || 'empty';
    console.log(`${problem.title.slice(0, 46).padEnd(48)} ${summary}`);
  }
  console.log(`\n${banked} verified question(s) across ${rows.length} ${kind} problem(s).`);
  console.log('An empty problem is not a fault: it fills the first time somebody sits it.');
} else if (command === 'show') {
  const [questionId] = positional;
  if (!questionId) throw new Error('Usage: node scripts/bank.js show <questionId>');
  const row = unwrap(
    await db.from('assessment_questions').select('*').eq('id', questionId).maybeSingle(),
    'load question',
  );
  if (!row) throw new Error('No such question');
  console.log(JSON.stringify(row, null, 2));
} else {
  console.log('Usage: node scripts/bank.js [status|show] [--kind LLD|HLD] [--problems N] [--problem <title>] [--all]');
  process.exit(1);
}
