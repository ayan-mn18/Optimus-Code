import crypto from 'node:crypto';
import { DEFAULT_LANGUAGE } from '../runner/index.js';

/**
 * The shape of a paper is decided here, not by the model.
 *
 * A generator asked for "a good test" returns a different distribution every
 * time and quietly drifts toward whatever it finds easy to write. A generator
 * asked to fill slot 4 — capacity estimation, Medium, single-select — cannot.
 * The blueprint is also what enforces the two rules that came from the product
 * side: at most two questions drawn from our own articles, and an LLD paper
 * that is mostly code.
 */

export const PASS_RATIO = 0.8;

const HLD_AREAS = [
  'requirements and scope',
  'capacity estimation',
  'API and interface design',
  'data modelling',
  'storage selection',
  'partitioning and sharding',
  'replication and consistency',
  'caching strategy',
  'failure modes and resilience',
  'scaling bottlenecks',
  'observability and operations',
  'rate limiting and abuse',
];

const LLD_AREAS = [
  'class responsibilities and SOLID',
  'design pattern choice',
  'state and invariants',
  'concurrency and thread safety',
  'extensibility under change',
];

/**
 * Concept areas where a picture carries something prose does not: a topology, a
 * request path, an ordering. Asking the model to decide produced no diagrams at
 * all in practice — it takes the "optional" escape every time — so the
 * blueprint decides here, exactly as it decides everything else about a paper.
 */
const DIAGRAM_AREAS = new Set([
  'API and interface design',
  'data modelling',
  'partitioning and sharding',
  'replication and consistency',
  'caching strategy',
  'failure modes and resilience',
  'scaling bottlenecks',
  'rate limiting and abuse',
  'class responsibilities and SOLID',
  'design pattern choice',
  'state and invariants',
  'concurrency and thread safety',
]);

/** At most this many diagrams per paper: past that they stop being a signal. */
const MAX_DIAGRAMS = 2;

/**
 * Marks the first couple of diagram-friendly slots as needing one, so a paper
 * reliably carries a diagram or two without every question turning into one.
 */
function withDiagrams(slots) {
  let remaining = MAX_DIAGRAMS;
  return slots.map((slot) => {
    if (slot.type !== 'mcq' || !remaining || !DIAGRAM_AREAS.has(slot.conceptArea)) return slot;
    remaining -= 1;
    return { ...slot, diagram: 'required' };
  });
}

/**
 * Three machine-coding tasks on one paper have to be three different exercises,
 * not the same contract renamed. Naming the angle in the slot is what makes the
 * generator produce three, since the calls run in parallel and cannot see each
 * other's output.
 */
const CODING_FOCUS = [
  'implementing the core algorithm',
  'modelling state and enforcing its invariants',
  'extending the design to meet one new requirement',
];

/** Topics where a SQL question is a fair thing to ask, rather than a non sequitur. */
const SQL_TOPICS = /\b(data|database|storage|sql|index|shard|warehouse|analytic|search|feed|ledger|payment|inventory)\b/i;

/** Deterministic PRNG so the same (user, problem, attempt) always plans the same paper. */
export function seededRandom(seedText) {
  let state = Number.parseInt(crypto.createHash('sha256').update(seedText).digest('hex').slice(0, 8), 16) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(items, random) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

const harder = (difficulty) => (difficulty === 'Easy' ? 'Medium' : 'Hard');

/**
 * @param {object} options
 * @param {object} options.problem      catalogue row
 * @param {string} options.userId
 * @param {number} options.attemptNumber 1-based
 * @param {string} [options.language]    the student's coding language
 * @param {boolean} [options.blogAvailable] whether we have an article to draw from
 */
export function planBlueprint({ problem, userId, attemptNumber, language = DEFAULT_LANGUAGE, blogAvailable = false }) {
  const seedText = `${userId}:${problem.id}:${attemptNumber}`;
  const random = seededRandom(seedText);
  const seed = Math.floor(random() * 1e9);
  // Half the LLD catalogue is explainer pages — "What is Low Level Design?",
  // "Class Relationships" — where a machine-coding task would be nonsense, and
  // plenty of HLD problems (rate limiter, consistent hashing, LRU) have a real
  // implementable core. So the catalogue flag decides this, not the kind.
  const codeable = problem.coding_enabled === true;
  const slots = withDiagrams(codeable
    ? mixedSlots({ problem, random, language, blogAvailable })
    : knowledgeSlots({ problem, random, blogAvailable }));

  return {
    version: 'optimus-blueprint-v3',
    kind: problem.kind,
    codeable,
    seed,
    language: codeable ? language : null,
    passRatio: PASS_RATIO,
    maxScore: slots.reduce((total, slot) => total + slot.weight, 0),
    slots,
  };
}

/** Ten equally weighted questions: every HLD paper, and every LLD explainer page. */
function knowledgeSlots({ problem, random, blogAvailable }) {
  const areas = shuffled(problem.kind === 'LLD' ? [...LLD_AREAS, ...HLD_AREAS] : HLD_AREAS, random).slice(0, 10);
  const sqlAllowed = SQL_TOPICS.test(`${problem.topic} ${problem.subtopic ?? ''} ${problem.title}`);
  // Two questions per paper come from our own write-up when one exists, and
  // never more — an assessment that only rewards reading our blog is not an
  // assessment.
  const blogSlots = blogAvailable ? 2 : 0;

  return areas.map((area, index) => {
    const base = {
      id: `q${index + 1}`,
      conceptArea: area,
      difficulty: index < 3 ? problem.difficulty : harder(problem.difficulty),
      weight: 1,
      source: index >= areas.length - blogSlots ? 'blog' : 'catalog',
    };
    // One data-shaped paper in three asks a real query instead of a question about queries.
    if (sqlAllowed && index === 4 && random() < 0.34) {
      return { ...base, type: 'sql', source: 'catalog' };
    }
    // Roughly a fifth of questions have more than one right answer, which stops
    // "eliminate three, pick the survivor" from working.
    return { ...base, type: 'mcq', selectionMode: random() < 0.2 ? 'multiple' : 'single' };
  });
}

/**
 * A codeable problem: six reasoning questions, then four you write code for.
 *
 * Order is load-bearing. The MCQs are drawn or generated in seconds and the
 * coding tasks take minutes, so putting the MCQs first buys the generator the
 * student's opening ten minutes. Only the first coding task is required — a
 * paper is still a paper with two, and the weight of anything dropped moves to
 * what survived.
 */
function mixedSlots({ problem, random, language, blogAvailable }) {
  const areas = shuffled([...LLD_AREAS, ...HLD_AREAS], random).slice(0, 6);
  const mcq = areas.map((area, index) => ({
    id: `q${index + 1}`,
    type: 'mcq',
    conceptArea: area,
    difficulty: index < 3 ? problem.difficulty : harder(problem.difficulty),
    selectionMode: random() < 0.25 ? 'multiple' : 'single',
    weight: 5,
    // At most one of a codeable paper's six MCQs leans on our article.
    source: blogAvailable && index === 5 ? 'blog' : 'catalog',
  }));

  const coding = shuffled(CODING_FOCUS, random).map((focus, index) => ({
    id: `q${index + 7}`,
    type: 'machine_coding',
    conceptArea: focus,
    difficulty: index === 0 ? problem.difficulty : harder(problem.difficulty),
    weight: 20,
    source: 'catalog',
    language,
    minutes: problem.difficulty === 'Hard' ? 35 : 25,
    // One coding task is the floor; the other two are worth having but not
    // worth holding a paper hostage to.
    optional: index > 0,
  }));

  return [
    ...mcq,
    ...coding,
    {
      id: 'q10',
      type: 'debug',
      conceptArea: 'reading code and finding the fault',
      difficulty: problem.difficulty,
      weight: 10,
      source: 'catalog',
      language,
      bugCount: random() < 0.35 ? 2 : 1,
      // Planting a bug that the tests actually catch is the least reliable thing
      // the generator does, and it needs a verified question to break.
      optional: true,
    },
  ];
}
