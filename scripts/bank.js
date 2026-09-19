#!/usr/bin/env node
/**
 * Fills and inspects the Optimus question bank from the command line.
 *
 * Generation is slow and occasionally produces a question that fails its own
 * verification, so the bank is warmed offline rather than in front of a student.
 * This is also the tool for reading what the model actually wrote before any of
 * it is shown to anyone.
 *
 *   node scripts/bank.js status --kind LLD
 *   node scripts/bank.js fill --kind LLD --problems 5 --each 3
 *   node scripts/bank.js show <questionId>
 *   node scripts/bank.js fill --kind HLD --problems 2 --dry
 */
import { db, unwrap } from '../src/lib/supabase.js';
import { env } from '../src/config/env.js';
import { planBlueprint } from '../src/services/assessment/blueprint.js';
import { bankDepth, generateMissing, loadArticle, storeQuestions } from '../src/services/assessment/bank.js';
import { toBankRow } from '../src/services/assessment/generator.js';

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
const problemLimit = Number(flags.problems ?? 3);
const perType = Number(flags.each ?? 1);

async function problems() {
  let query = db
    .from('problems')
    .select('*')
    .eq('kind', kind)
    .eq('assessment_enabled', true);
  // Half the LLD catalogue is explainer pages. Warming those first would spend
  // the whole budget on multiple choice about "What is Low Level Design?".
  if (kind === 'LLD' && !flags.all) query = query.eq('coding_enabled', true);
  if (flags.problem) query = query.ilike('title', `%${flags.problem}%`);

  const rows = unwrap(await query.order('order_index').limit(problemLimit), 'load problems');
  if (!rows.length) throw new Error(`No matching ${kind} problems with assessments enabled`);
  return rows;
}

if (command === 'status') {
  for (const problem of await problems()) {
    const depth = await bankDepth(problem.id);
    const summary = Object.entries(depth).map(([type, count]) => `${type}=${count}`).join(' ') || 'empty';
    console.log(`${problem.title.slice(0, 46).padEnd(48)} ${summary}`);
  }
} else if (command === 'show') {
  const [questionId] = positional;
  if (!questionId) throw new Error('Usage: node scripts/bank.js show <questionId>');
  const row = unwrap(
    await db.from('assessment_questions').select('*').eq('id', questionId).maybeSingle(),
    'load question',
  );
  if (!row) throw new Error('No such question');
  console.log(JSON.stringify(row, null, 2));
} else if (command === 'fill') {
  if (!env.ai.enabled) throw new Error('LLM_API_KEY is required to generate questions');
  const wanted = kind === 'LLD' && !flags.all ? ['machine_coding', 'debug', 'mcq'] : ['mcq'];
  let made = 0;
  let discarded = 0;

  for (const problem of await problems()) {
    const article = await loadArticle(problem.id);
    for (let round = 0; round < perType; round += 1) {
      const blueprint = planBlueprint({
        problem,
        userId: `bank-cli-${round}`,
        attemptNumber: Date.now() % 100_000,
        blogAvailable: Boolean(article),
      });
      // One slot of each type we want, taken from a real blueprint so the
      // generated questions match what a paper will actually ask for.
      const slots = wanted
        .map((type) => blueprint.slots.find((slot) => slot.type === type))
        .filter(Boolean);

      const started = Date.now();
      try {
        const produced = await generateMissing({ problem, slots, seed: blueprint.seed + round, article, continueOnError: true });
        const rows = produced.map(({ generated }) => toBankRow({ problem, generated }));
        if (flags.dry) {
          for (const row of rows) console.log(`  [dry] ${row.kind.padEnd(15)} ${JSON.stringify(row.payload).length} bytes  ${row.payload.title ?? row.payload.prompt?.slice(0, 60)}`);
        } else {
          const stored = await storeQuestions(rows);
          made += stored.length;
        }
        console.log(`${problem.title.slice(0, 40).padEnd(42)} round ${round + 1}: ${rows.length} kept in ${((Date.now() - started) / 1000).toFixed(0)}s`);
        for (const failure of produced.failures ?? []) {
          discarded += 1;
          console.log(`  discarded ${failure.slice(0, 150)}`);
        }
      } catch (error) {
        discarded += 1;
        console.log(`${problem.title.slice(0, 40).padEnd(42)} round ${round + 1}: discarded — ${error.message.split('\n')[0].slice(0, 160)}`);
      }
    }
  }
  console.log(`\nstored ${made}, discarded ${discarded} round(s)`);
} else {
  console.log('Usage: node scripts/bank.js [status|fill|show] [--kind LLD|HLD] [--problems N] [--each N] [--problem <title>] [--all] [--dry]');
  process.exit(1);
}
