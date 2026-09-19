import test from 'node:test';
import assert from 'node:assert/strict';

import { PASS_RATIO, planBlueprint } from '../src/services/assessment/blueprint.js';
import { SCHEMAS, fingerprint, isParamType, isReturnType } from '../src/services/assessment/schemas.js';
import { generateCodingQuestion, generateDebugQuestion, generateMcqSet } from '../src/services/assessment/generator.js';
import { chooseFromPool, redistribute } from '../src/services/assessment/bank.js';
import { thinnestKind } from '../src/services/assessment/worker.js';
import { publicQuestion, scoreMultipleChoice, upgradeLegacyEntry } from '../src/services/assessment.service.js';

const HLD = { id: 'p-hld', kind: 'HLD', title: 'Design a URL Shortener', topic: 'Data storage', difficulty: 'Medium' };
const LLD = { id: 'p-lld', kind: 'LLD', title: 'Design a Parking Lot', topic: 'Object oriented design', difficulty: 'Medium', coding_enabled: true };

/* -------------------------------------------------------------------------- */

test('an HLD paper is ten equally weighted questions', () => {
  const plan = planBlueprint({ problem: HLD, userId: 'u1', attemptNumber: 1 });
  assert.equal(plan.slots.length, 10);
  assert.equal(plan.maxScore, 10);
  assert.ok(plan.slots.every((slot) => ['mcq', 'sql'].includes(slot.type)));
  assert.equal(new Set(plan.slots.map((slot) => slot.conceptArea)).size, 10);
});

test('an LLD paper is mostly code', () => {
  const plan = planBlueprint({ problem: LLD, userId: 'u1', attemptNumber: 1, language: 'java' });
  const weights = Object.fromEntries(plan.slots.map((slot) => [slot.type === 'mcq' ? slot.id : slot.type, slot.weight]));
  assert.equal(plan.maxScore, 100);
  assert.equal(weights.machine_coding, 60);
  assert.equal(weights.debug, 25);
  assert.equal(plan.slots.filter((slot) => slot.type === 'mcq').length, 3);
  assert.equal(plan.language, 'java');
});

test('at most two questions come from our own article, and none when there is no article', () => {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const withBlog = planBlueprint({ problem: HLD, userId: 'u1', attemptNumber: attempt, blogAvailable: true });
    assert.ok(withBlog.slots.filter((slot) => slot.source === 'blog').length <= 2);
    const without = planBlueprint({ problem: HLD, userId: 'u1', attemptNumber: attempt, blogAvailable: false });
    assert.equal(without.slots.filter((slot) => slot.source === 'blog').length, 0);
  }
});

test('the same student and attempt always plan the same paper, and different attempts do not', () => {
  const first = planBlueprint({ problem: HLD, userId: 'u1', attemptNumber: 1 });
  assert.deepEqual(planBlueprint({ problem: HLD, userId: 'u1', attemptNumber: 1 }), first);
  assert.notDeepEqual(planBlueprint({ problem: HLD, userId: 'u1', attemptNumber: 2 }).slots, first.slots);
  assert.notDeepEqual(planBlueprint({ problem: HLD, userId: 'u2', attemptNumber: 1 }).slots, first.slots);
});

/* -------------------------------------------------------------------------- */

test('the type vocabulary is closed, and map keys are stricter on the way in', () => {
  assert.ok(isParamType('int') && isParamType('list<string>') && isParamType('map<string,int>'));
  assert.ok(!isParamType('Vehicle') && !isParamType('list<Ticket>') && !isParamType('any'));
  assert.ok(isReturnType('void') && isReturnType('list<list<int>>'));
  assert.ok(!isReturnType('Optional<int>'));

  // An argument arrives as JSON, where every key is text — so Java would pass a
  // real Integer while Python and JavaScript saw a string. Returning one is fine.
  assert.equal(isParamType('map<int,int>'), false);
  assert.equal(isReturnType('map<int,int>'), true);
  assert.equal(isReturnType('list<map<int,int>>'), true);
});

test('a class name and answer key that are only cosmetically off are snapped, not rejected', async () => {
  const chatImpl = async () => ({
    ...codingFixture(),
    entity: { ...codingFixture().entity, name: 'token_bucket' },
  });
  const { question } = await generateCodingQuestion({
    problem: LLD, slot: { conceptArea: 'x', difficulty: 'Medium' }, seed: 1, chatImpl, transport: fakeTransport(),
  });
  assert.equal(question.entity.name, 'TokenBucket');

  const mcqImpl = async () => ({
    questions: [{
      id: 'q1', label: 'Caching', prompt: 'A prompt long enough to count as a real question.', context: '',
      selectionMode: 'single',
      options: ['Write through the cache', 'Write around it', 'Write back on eviction'],
      // Same answer, trailing full stop and stray spacing.
      correctAnswers: ['  write through the cache. '],
      explanation: 'It is right because of the stated constraint.',
    }],
  });
  const [item] = await generateMcqSet({
    problem: HLD,
    slots: [{ id: 'q1', type: 'mcq', conceptArea: 'caching strategy', difficulty: 'Medium', selectionMode: 'single', source: 'catalog' }],
    seed: 1,
    chatImpl: mcqImpl,
  });
  assert.deepEqual(item.question.correctAnswers, ['Write through the cache']);
});

test('an MCQ with no wrong answer, or a key outside its options, is rejected', () => {
  const base = {
    kind: 'mcq', label: 'Sharding', prompt: 'A question long enough to be a real question about sharding.',
    context: '', selectionMode: 'single', options: ['a', 'b', 'c'], correctAnswers: ['a'],
    explanation: 'Because a is the only option that survives the stated constraint.',
  };
  assert.ok(SCHEMAS.mcq.safeParse(base).success);
  assert.ok(!SCHEMAS.mcq.safeParse({ ...base, correctAnswers: ['d'] }).success);
  assert.ok(!SCHEMAS.mcq.safeParse({ ...base, correctAnswers: ['a', 'b', 'c'] }).success);
  assert.ok(!SCHEMAS.mcq.safeParse({ ...base, selectionMode: 'multiple', correctAnswers: ['a'] }).success);
  assert.ok(!SCHEMAS.mcq.safeParse({ ...base, options: ['a', 'a', 'b'] }).success);
});

const codingFixture = (overrides = {}) => ({
  kind: 'machine_coding',
  title: 'Token bucket',
  statement: 'x'.repeat(200),
  entity: {
    name: 'Bucket',
    constructorParams: [{ name: 'capacity', type: 'int' }],
    methods: [{ name: 'take', params: [{ name: 'count', type: 'int' }], returns: 'bool' }],
  },
  tests: [
    { name: 'visible a', visible: true, steps: [{ op: 'new', args: [2] }, { op: 'take', args: [1], expect: true }] },
    { name: 'visible b', visible: true, steps: [{ op: 'new', args: [2] }, { op: 'take', args: [3], expect: false }] },
    ...Array.from({ length: 4 }, (_unused, index) => ({
      name: `hidden ${index}`,
      visible: false,
      steps: [{ op: 'new', args: [2] }, { op: 'take', args: [index], expect: index <= 2 }],
    })),
  ],
  referenceSolution: { language: 'python', source: '# reference\nclass Bucket:\n    pass\n'.padEnd(60, '#') },
  rubricNotes: 'A strong answer keeps the invariant obvious.',
  ...overrides,
});

test('a coding question must exercise its own contract', () => {
  assert.ok(SCHEMAS.machine_coding.safeParse(codingFixture()).success);

  const noHidden = codingFixture({ tests: codingFixture().tests.map((item) => ({ ...item, visible: true })) });
  assert.match(SCHEMAS.machine_coding.safeParse(noHidden).error.issues[0].message, /hidden/);

  const unknownMethod = codingFixture();
  unknownMethod.tests[0].steps[1].op = 'drip';
  assert.match(SCHEMAS.machine_coding.safeParse(unknownMethod).error.issues[0].message, /unknown method/);

  const wrongArity = codingFixture();
  wrongArity.tests[0].steps[1].args = [1, 2];
  assert.match(SCHEMAS.machine_coding.safeParse(wrongArity).error.issues[0].message, /arity/);

  const checksNothing = codingFixture();
  delete checksNothing.tests[0].steps[1].expect;
  assert.match(SCHEMAS.machine_coding.safeParse(checksNothing).error.issues[0].message, /never checks/);
});

test('fingerprints ignore wording, follow what a question asks, and separate the kinds', () => {
  const one = codingFixture();
  const two = codingFixture({ title: 'A different title entirely' });
  assert.equal(fingerprint(one), fingerprint(two));
  assert.notEqual(fingerprint(one), fingerprint(codingFixture({ statement: 'y'.repeat(200) })));

  // A debug exercise shares its base's class, statement and tests. If it shared
  // the fingerprint too, storing it would overwrite the question it came from.
  const asDebug = { ...codingFixture(), kind: 'debug', buggySource: 'x', bugSummary: 'y' };
  assert.notEqual(fingerprint(one), fingerprint(asDebug));
});

/* -------------------------------------------------------------------------- */
/* Generation — fake model, fake judge                                        */
/* -------------------------------------------------------------------------- */

/** Judges by what the source says about itself, so a test can choose the verdict. */
const fakeTransport = () => ({
  execute: async (body) => {
    const source = body.source_code ?? Buffer.from(body.additional_files ?? '', 'base64').toString('latin1');
    const marker = /__OPTIMUS_[0-9A-F]+__/.exec(source)[0];
    const names = [...source.matchAll(/"name": ?"([^"]+)"/g)].map((match) => match[1]);
    const decoded = /b64decode\('([^']+)'\)/.exec(source);
    const tests = decoded ? JSON.parse(Buffer.from(decoded[1], 'base64').toString('utf8')) : names.map((name) => ({ name }));
    const verdict = (index) => {
      if (source.includes('# reference')) return true;
      if (source.includes('# buggy')) return index !== 0;
      return false;   // the empty starter
    };
    const results = tests.map((item, index) => ({ name: item.name, passed: verdict(index) }));
    return {
      stdout: `${marker}${JSON.stringify(results)}`,
      stderr: '', compileOutput: '', message: null, status: { description: 'Accepted' }, time: '0.01', memory: 1024,
    };
  },
});

test('generation renames fields, casing and void expectations rather than discarding the question', async () => {
  const prompts = [];
  const chatImpl = async (options) => {
    prompts.push(options.schemaName);
    return {
    title: 'Token bucket',
    statement: 'x'.repeat(200),
    entity: {
      className: 'Bucket',
      constructor: [{ parameterName: 'capacity', parameterType: 'int' }],
      methods: [
        { methodName: 'take_one', parameters: [{ parameterName: 'count', parameterType: 'int' }], returnType: 'bool' },
        { methodName: 'reset', parameters: [], returnType: 'void' },
      ],
    },
    tests: codingFixture().tests.map((item) => ({
      ...item,
      steps: [item.steps[0], { ...item.steps[1], op: 'take_one' }, { op: 'reset', args: [], expect: null }],
    })),
      referenceSolution: { language: 'python', source: '# reference\nclass Bucket:\n    pass\n'.padEnd(60, '#') },
      rubricNotes: 'A strong answer keeps the invariant obvious.',
    };
  };

  const { question, verification } = await generateCodingQuestion({
    problem: LLD, slot: { conceptArea: 'implementing the design', difficulty: 'Medium' }, seed: 1, chatImpl, transport: fakeTransport(),
  });

  assert.equal(question.entity.methods[0].name, 'takeOne');
  assert.equal(question.tests[0].steps[1].op, 'takeOne');
  // The void call survives; only its meaningless expectation is dropped.
  assert.equal(question.tests[0].steps[2].op, 'reset');
  assert.equal(Object.hasOwn(question.tests[0].steps[2], 'expect'), false);
  assert.equal(verification.referencePassed, 6);
  assert.equal(verification.stubPassed, 0);
  // The contract and the code are settled before the tests are asked for.
  assert.deepEqual(prompts, ['coding_spec', 'test_suite']);
});

test('a question whose tests an empty skeleton passes is refused', async () => {
  // This reference claims nothing about itself, so the fake judge fails it —
  // and a reference that cannot pass its own tests never reaches a student.
  const chatImpl = async () => codingFixture({ referenceSolution: { language: 'python', source: 'class Bucket:\n    pass\n'.padEnd(60, '#') } });
  await assert.rejects(
    generateCodingQuestion({ problem: LLD, slot: { conceptArea: 'x', difficulty: 'Medium' }, seed: 1, chatImpl, transport: fakeTransport() }),
    /Verification failed after repair/,
  );
});

test('a debug question is built from a verified one and must actually break', async () => {
  const base = codingFixture();
  const chatImpl = async () => ({
    fixedSource: '# reference\nclass Bucket:\n    pass\n'.padEnd(60, '#'),
    buggySource: '# buggy\nclass Bucket:\n    pass\n'.padEnd(60, '#'),
    bugSummary: 'The boundary check uses > where it should use >=.',
    rubricNotes: 'A strong answer reads the boundary first.',
  });

  const { question, verification } = await generateDebugQuestion({
    problem: LLD, slot: { conceptArea: 'reading code', difficulty: 'Medium', language: 'python', bugCount: 1 },
    seed: 1, base, chatImpl, transport: fakeTransport(),
  });
  assert.equal(question.kind, 'debug');
  assert.equal(question.statement, base.statement);
  assert.match(question.buggySource, /# buggy/);
  assert.equal(verification.buggyFailed, 1);

  // A "bug" that breaks nothing is not a debugging exercise.
  const harmless = async () => ({
    fixedSource: '# reference\nclass Bucket:\n    pass\n'.padEnd(60, '#'),
    buggySource: '# reference\nclass Bucket:\n    pass\n'.padEnd(60, '#'),
    bugSummary: 'Nothing is actually wrong here.',
    rubricNotes: 'x'.repeat(30),
  });
  let calls = 0;
  const harmlessThenFixed = async (options) => {
    calls += 1;
    return calls === 1 ? harmless(options) : chatImpl(options);
  };
  // A bug nothing catches gets one more go with the observed outcome in hand.
  const { verification: retried } = await generateDebugQuestion({
    problem: LLD, slot: { conceptArea: 'reading code', difficulty: 'Medium', language: 'python', bugCount: 1 },
    seed: 1, base, chatImpl: harmlessThenFixed, transport: fakeTransport(),
  });
  assert.equal(calls, 2);
  assert.equal(retried.buggyFailed, 1);

  await assert.rejects(
    generateDebugQuestion({
      problem: LLD, slot: { conceptArea: 'reading code', difficulty: 'Medium', language: 'python', bugCount: 1 },
      seed: 1, base, chatImpl: harmless, transport: fakeTransport(),
    }),
    /no bug to find/,
  );
});

test('a scenario that checks nothing is dropped, not fatal, and throws-aliases are absorbed', async () => {
  const fixture = codingFixture();
  const chatImpl = async () => ({
    ...fixture,
    tests: [
      ...fixture.tests,
      // Exercises the object and asserts nothing — dropped.
      { name: 'just pokes it', visible: false, steps: [{ op: 'new', args: [2] }, { op: 'take', args: [1] }] },
      // "Must raise", spelled the way a model spells it.
      { name: 'rejects nonsense', visible: false, steps: [{ op: 'new', args: [2] }, { op: 'take', args: [-1], expectError: true }] },
    ],
  });

  const { question } = await generateCodingQuestion({
    problem: LLD, slot: { conceptArea: 'x', difficulty: 'Medium' }, seed: 1, chatImpl, transport: fakeTransport(),
  });
  assert.equal(question.tests.some((test) => test.name === 'just pokes it'), false);
  const rejects = question.tests.find((test) => test.name === 'rejects nonsense');
  assert.equal(rejects.steps[1].throws, true);
});

test('an over-long suite is trimmed to fit, keeping every visible scenario', async () => {
  const fixture = codingFixture();
  const chatImpl = async () => ({
    ...fixture,
    rubricNotes: 'x'.repeat(4000),
    tests: [
      ...fixture.tests,
      ...Array.from({ length: 40 }, (_unused, index) => ({
        name: `extra ${index}`,
        visible: false,
        steps: [{ op: 'new', args: [2] }, { op: 'take', args: [1], expect: true }],
      })),
    ],
  });

  const { question } = await generateCodingQuestion({
    problem: LLD, slot: { conceptArea: 'x', difficulty: 'Medium' }, seed: 1, chatImpl, transport: fakeTransport(),
  });
  assert.equal(question.tests.length, 30);
  assert.equal(question.tests.filter((test) => test.visible).length, 2);
  assert.equal(question.rubricNotes.length, 2500);
});

test('the MCQ generator holds the model to the blueprint it was given', async () => {
  const slots = [
    { id: 'q1', type: 'mcq', conceptArea: 'caching strategy', difficulty: 'Medium', selectionMode: 'single', source: 'catalog' },
  ];
  const chatImpl = async () => ({
    questions: [{
      id: 'q1', label: 'Caching', prompt: 'A prompt long enough to count as a real question.', context: '',
      selectionMode: 'single', options: ['a', 'b', 'c', 'd'], correctAnswers: ['b'], explanation: 'b is right because of the stated constraint.',
    }],
  });
  const [item] = await generateMcqSet({ problem: HLD, slots, seed: 1, chatImpl });
  assert.equal(item.meta.conceptArea, 'caching strategy');

  const wrongCount = async () => ({ questions: [] });
  await assert.rejects(generateMcqSet({ problem: HLD, slots, seed: 1, chatImpl: wrongCount }), /Expected 1 questions/);
});

/* -------------------------------------------------------------------------- */
/* Redaction and scoring                                                       */
/* -------------------------------------------------------------------------- */

test('nothing a student receives contains the answer key or the hidden tests', () => {
  const mcq = publicQuestion({
    slotId: 'q1', type: 'mcq', weight: 1, conceptArea: 'caching',
    payload: {
      label: 'Caching', prompt: 'p', context: '', selectionMode: 'single',
      options: ['a', 'b'], correctAnswers: ['b'], explanation: 'because',
    },
  });
  assert.deepEqual(mcq.options, ['a', 'b']);
  assert.equal(mcq.correctAnswers, undefined);
  assert.equal(mcq.explanation, undefined);

  const coding = publicQuestion({
    slotId: 'q5', type: 'machine_coding', weight: 60, conceptArea: 'implementing', payload: codingFixture(),
  });
  assert.equal(coding.visibleTests.length, 2);
  assert.ok(coding.visibleTests.every((item) => item.name.startsWith('visible')));
  assert.equal(JSON.stringify(coding).includes('hidden'), false);
  assert.equal(JSON.stringify(coding).includes('# reference'), false);
  assert.deepEqual(Object.keys(coding.starters).sort(), ['java', 'javascript', 'python']);

  const debug = publicQuestion({
    slotId: 'q4', type: 'debug', weight: 25, conceptArea: 'reading', language: 'python',
    payload: { ...codingFixture(), kind: 'debug', buggySource: '# buggy code', bugSummary: 'off by one' },
  });
  assert.deepEqual(Object.keys(debug.starters), ['python']);
  assert.equal(debug.starters.python, '# buggy code');
  assert.equal(JSON.stringify(debug).includes('off by one'), false);

  const sql = publicQuestion({
    slotId: 'q5', type: 'sql', weight: 1, conceptArea: 'data modelling',
    payload: {
      title: 't', statement: 's', schema: 'CREATE TABLE a (id INT);', orderMatters: true,
      referenceQuery: 'SELECT secret FROM a',
      tests: [
        { name: 'sample', visible: true, seed: 'INSERT INTO a VALUES (1);', expectedStdout: '1' },
        { name: 'hidden', visible: false, seed: 'INSERT INTO a VALUES (2);', expectedStdout: '2' },
      ],
    },
  });
  assert.equal(sql.sampleSeed, 'INSERT INTO a VALUES (1);');
  assert.equal(JSON.stringify(sql).includes('SELECT secret'), false);
  assert.equal(JSON.stringify(sql).includes('expectedStdout'), false);
});

test('papers taken before v3 stay readable and still hide their answer key', () => {
  const legacy = {
    id: 'q3', type: 'multiple_choice', label: 'Sharding', prompt: 'Which partition key?',
    context: 'A table of events.', selectionMode: 'single', options: ['user_id', 'created_at'],
    correctAnswers: ['user_id'],
  };
  const upgraded = upgradeLegacyEntry(legacy);
  assert.equal(upgraded.slotId, 'q3');
  assert.equal(upgraded.type, 'mcq');
  assert.deepEqual(upgraded.payload.correctAnswers, ['user_id']);

  const shown = publicQuestion(legacy);
  assert.equal(shown.id, 'q3');
  assert.deepEqual(shown.options, ['user_id', 'created_at']);
  assert.equal(shown.correctAnswers, undefined);
});

test('multi-select grading needs the exact set', () => {
  const question = { correctAnswers: ['availability', 'latency'] };
  assert.equal(scoreMultipleChoice(question, { values: ['latency', 'availability'] }).ratio, 1);
  assert.equal(scoreMultipleChoice(question, { values: ['availability'] }).ratio, 0);
  assert.equal(scoreMultipleChoice(question, { values: ['availability', 'latency', 'cost'] }).ratio, 0);
  assert.equal(scoreMultipleChoice(question, {}).ratio, 0);
});

test('eighty percent passes, and a hair under does not', () => {
  // The weighted shape of a real LLD paper: 3x5 + 25 + 60.
  const score = (mcqCorrect, debugRatio, codingRatio) => mcqCorrect * 5 + debugRatio * 25 + codingRatio * 60;
  assert.equal(score(3, 1, 1) / 100 >= PASS_RATIO, true);
  assert.equal(score(3, 1, 0.667) / 100 >= PASS_RATIO, true);    // 80.02
  assert.equal(score(3, 1, 0.66) / 100 >= PASS_RATIO, false);    // 79.6
  assert.equal(score(0, 1, 1) / 100 >= PASS_RATIO, true);        // code carries the paper
  assert.equal(score(3, 1, 0) / 100 >= PASS_RATIO, false);       // theory alone does not
});

/* -------------------------------------------------------------------------- */

test('the draw prefers a matching slot but never refuses a paper over it', () => {
  const random = () => 0.5;
  const pool = [
    { id: 'far', concept_area: 'caching strategy', difficulty: 'Hard', source: 'catalog', times_served: 0 },
    { id: 'near', concept_area: 'data modelling', difficulty: 'Medium', source: 'catalog', times_served: 0 },
    { id: 'tired', concept_area: 'data modelling', difficulty: 'Medium', source: 'catalog', times_served: 9 },
  ];
  const slot = { conceptArea: 'data modelling', difficulty: 'Medium', source: 'catalog' };
  assert.equal(chooseFromPool(pool, slot, random).id, 'near');
  assert.equal(chooseFromPool([pool[0]], slot, random).id, 'far');
  assert.equal(chooseFromPool([], slot, random), null);
});

test('a droppable slot hands its marks to the heaviest remaining question', () => {
  const ordered = [
    { slot: { id: 'q1', weight: 5 }, row: {} },
    { slot: { id: 'q2', weight: 5 }, row: {} },
    { slot: { id: 'q3', weight: 5 }, row: {} },
    { slot: { id: 'q5', weight: 60 }, row: {} },
  ];
  const result = redistribute(ordered, [{ id: 'q4', weight: 25, optional: true }]);
  // The paper is still out of 100, so 80% means what it always meant.
  assert.equal(result.reduce((total, entry) => total + entry.slot.weight, 0), 100);
  assert.equal(result.find((entry) => entry.slot.id === 'q5').slot.weight, 85);
  assert.deepEqual(redistribute(ordered, []), ordered);
});

test('the worker tops up the thinnest slot type and stops when stocked', () => {
  assert.equal(thinnestKind({ mcq: 30, machine_coding: 2, debug: 20 }, LLD), 'machine_coding');
  assert.equal(thinnestKind({ mcq: 30, machine_coding: 20, debug: 20 }, LLD), null);
  assert.equal(thinnestKind({ mcq: 3 }, HLD), 'mcq');
  // Neither an HLD paper nor an LLD explainer needs a coding bank.
  assert.equal(thinnestKind({ mcq: 40 }, HLD), null);
  assert.equal(thinnestKind({ mcq: 40 }, { kind: 'LLD', coding_enabled: false }), null);
});

test('an LLD explainer page is a knowledge paper, not a coding one', () => {
  const explainer = { id: 'p-doc', kind: 'LLD', title: 'Class Relationships: A Deep Dive', topic: 'OOP', difficulty: 'Easy', coding_enabled: false };
  const plan = planBlueprint({ problem: explainer, userId: 'u1', attemptNumber: 1 });
  assert.equal(plan.codeable, false);
  assert.equal(plan.maxScore, 10);
  assert.ok(plan.slots.every((slot) => ['mcq', 'sql'].includes(slot.type)));
  assert.equal(plan.language, null);

  // The interview problems still get the coding paper.
  assert.equal(planBlueprint({ problem: LLD, userId: 'u1', attemptNumber: 1 }).maxScore, 100);
});
