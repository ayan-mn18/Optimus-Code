import crypto from 'node:crypto';
import { z } from 'zod';

/**
 * What a generated question is allowed to be.
 *
 * These schemas are the contract the model is held to, and they are deliberately
 * narrower than what a model would produce unprompted. The tight spots are the
 * type vocabulary and the identifier rules: a question is answered in Python,
 * JavaScript or Java, so anything that cannot be spelled in all three cannot
 * appear in a signature.
 */

const SCALAR = ['int', 'long', 'double', 'bool', 'string'];
const SCALARS = new Set(SCALAR);

/**
 * Everything we can emit as a literal in all three languages: scalars, and one
 * level of nesting inside a list or a string-keyed map. Deeper than that is not
 * a machine-coding question, it is a serialisation exercise.
 */
const SCALAR_PATTERN = '(int|long|double|bool|string)';

/**
 * Map keys are the one place parameters and returns differ.
 *
 * An argument crosses into the sandbox as JSON, where every object key is a
 * string — so Python and JavaScript receive `"1"` while the generated Java call
 * passes a real `Integer`, and an implementation that mixes the two ends up with
 * both keys in the same map. Returning an index-keyed map is fine, because the
 * canonical form renders every key as text on both sides.
 */
const NESTED = new RegExp(`^(list<${SCALAR_PATTERN}>|map<string,\\s*${SCALAR_PATTERN}>)$`);

export const isParamType = (type) => SCALARS.has(type)
  || NESTED.test(type)
  || new RegExp(`^list<(list<${SCALAR_PATTERN}>|map<string,\\s*${SCALAR_PATTERN}>)>$`).test(type)
  || new RegExp(`^map<string,\\s*(list<${SCALAR_PATTERN}>)>$`).test(type);

const KEY_PATTERN = '(string|int|long)';
export const isReturnType = (type) => type === 'void'
  || isParamType(type)
  || new RegExp(`^map<${KEY_PATTERN},\\s*${SCALAR_PATTERN}>$`).test(type)
  || new RegExp(`^map<${KEY_PATTERN},\\s*list<${SCALAR_PATTERN}>>$`).test(type)
  || new RegExp(`^list<map<${KEY_PATTERN},\\s*${SCALAR_PATTERN}>>$`).test(type);

// The union of what Java, Python and JavaScript refuse as an identifier, plus the
// handful of names that compile but shadow something important.
const RESERVED = new Set([
  'abstract', 'and', 'as', 'assert', 'async', 'await', 'boolean', 'break', 'byte', 'case', 'catch', 'char',
  'class', 'const', 'continue', 'def', 'default', 'del', 'do', 'double', 'elif', 'else', 'enum',
  'except', 'export', 'extends', 'false', 'final', 'finally', 'float', 'for', 'from', 'function', 'global',
  'goto', 'if', 'implements', 'import', 'in', 'instanceof', 'int', 'interface', 'is', 'lambda', 'let',
  'long', 'native', 'new', 'none', 'nonlocal', 'not', 'null', 'or', 'package', 'pass', 'private',
  'protected', 'public', 'raise', 'return', 'short', 'static', 'super', 'switch', 'synchronized', 'this',
  'throw', 'throws', 'transient', 'true', 'try', 'typeof', 'var', 'void', 'volatile', 'while', 'with', 'yield',
]);

const identifier = (pattern, label) => z.string().min(1).max(40).refine(
  (value) => pattern.test(value) && !RESERVED.has(value.toLowerCase()),
  { message: `${label} must match ${pattern} and must not be a reserved word` },
);

const paramSchema = z.object({
  name: identifier(/^[a-z][A-Za-z0-9]*$/, 'Parameter name'),
  type: z.string().refine(isParamType, (value) => ({ message: `Parameter type "${value}" is outside the supported vocabulary` })),
});

const entitySchema = z.object({
  name: identifier(/^[A-Z][A-Za-z0-9]*$/, 'Class name'),
  constructorParams: z.array(paramSchema).max(5),
  methods: z.array(z.object({
    name: identifier(/^[a-z][A-Za-z0-9]*$/, 'Method name'),
    params: z.array(paramSchema).max(5),
    returns: z.string().refine(isReturnType, (value) => ({ message: `Return type "${value}" is outside the supported vocabulary` })),
  })).min(1).max(6),
}).superRefine((entity, context) => {
  const names = entity.methods.map((method) => method.name);
  if (new Set(names).size !== names.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Method names must be unique' });
  }
});

// `expect` holds a JSON value of any supported shape; the runner canonicalises it.
const jsonValue = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.any()), z.record(z.any())]);

const stepSchema = z.object({
  op: z.string().min(1).max(40),
  args: z.array(jsonValue).max(6).default([]),
  expect: jsonValue.optional(),
  // Rejecting bad input by raising is a normal design choice, so a test has to
  // be able to say so. Without this the only expressible contract is an error
  // code, and models write exception tests whether we allow them or not.
  throws: z.boolean().optional(),
});

const testSchema = z.object({
  name: z.string().min(3).max(80),
  visible: z.boolean(),
  steps: z.array(stepSchema).min(1).max(60),
});

export const mcqSchema = z.object({
  kind: z.literal('mcq'),
  label: z.string().min(1).max(80),
  prompt: z.string().min(20).max(1400),
  context: z.string().max(2000).default(''),
  selectionMode: z.enum(['single', 'multiple']),
  options: z.array(z.string().min(1).max(400)).min(3).max(6),
  correctAnswers: z.array(z.string().min(1).max(400)).min(1).max(4),
  explanation: z.string().min(20).max(1600),
}).superRefine((question, context) => {
  if (new Set(question.options).size !== question.options.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Options must be unique' });
  }
  if (question.correctAnswers.some((answer) => !question.options.includes(answer))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Every correct answer must be one of the options' });
  }
  if (question.selectionMode === 'single' && question.correctAnswers.length !== 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Single-select questions have exactly one answer' });
  }
  if (question.selectionMode === 'multiple' && question.correctAnswers.length < 2) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Multi-select questions have at least two answers' });
  }
  if (question.correctAnswers.length >= question.options.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'At least one option must be wrong' });
  }
});

const codeBody = {
  title: z.string().min(5).max(120),
  statement: z.string().min(120).max(6000),
  entity: entitySchema,
  tests: z.array(testSchema).min(6).max(30),
  referenceSolution: z.object({
    language: z.enum(['python', 'javascript', 'java']),
    source: z.string().min(40).max(20_000),
  }),
  rubricNotes: z.string().max(2500).optional().default(''),
};

export const machineCodingSchema = z.object({ kind: z.literal('machine_coding'), ...codeBody })
  .superRefine((question, context) => validateTests(question, context));

export const debugSchema = z.object({
  kind: z.literal('debug'),
  ...codeBody,
  buggySource: z.string().min(40).max(20_000),
  bugSummary: z.string().min(10).max(3000),
}).superRefine((question, context) => validateTests(question, context));

export const sqlSchema = z.object({
  kind: z.literal('sql'),
  title: z.string().min(5).max(120),
  statement: z.string().min(60).max(3000),
  schema: z.string().min(20).max(4000),
  orderMatters: z.boolean(),
  referenceQuery: z.string().min(10).max(2000),
  seeds: z.array(z.object({
    name: z.string().min(3).max(80),
    sql: z.string().min(10).max(6000),
  })).min(3).max(5),
  rubricNotes: z.string().max(2500).optional().default(''),
}).superRefine((question, context) => {
  if (/\b(drop|attach|pragma)\b/i.test(question.schema)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Schema may only create tables' });
  }
  if (!/^\s*(with|select)\b/i.test(question.referenceQuery)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'The reference answer must be a query' });
  }
});

function validateTests(question, context) {
  const methods = new Map(question.entity.methods.map((method) => [method.name, method]));
  const visible = question.tests.filter((test) => test.visible).length;
  if (visible < 2) context.addIssue({ code: z.ZodIssueCode.custom, message: 'At least two tests must be visible' });
  if (question.tests.length - visible < 4) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'At least four tests must be hidden' });
  }
  if (new Set(question.tests.map((test) => test.name)).size !== question.tests.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Test names must be unique' });
  }

  for (const test of question.tests) {
    if (test.steps[0]?.op !== 'new') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${test.name} must start by constructing the class` });
      continue;
    }
    if ((test.steps[0].args ?? []).length !== question.entity.constructorParams.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${test.name} passes the wrong number of constructor arguments` });
    }
    for (const step of test.steps.slice(1)) {
      const method = methods.get(step.op);
      if (!method) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `${test.name} calls unknown method ${step.op}` });
        continue;
      }
      if ((step.args ?? []).length !== method.params.length) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `${test.name} calls ${step.op} with the wrong arity` });
      }
      if (method.returns === 'void' && Object.hasOwn(step, 'expect') && !step.throws) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `${step.op} returns nothing, so it cannot have an expectation` });
      }
    }
    if (!test.steps.slice(1).some((step) => Object.hasOwn(step, 'expect') || step.throws)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${test.name} never checks anything` });
    }
  }
}

export const SCHEMAS = {
  mcq: mcqSchema,
  machine_coding: machineCodingSchema,
  debug: debugSchema,
  sql: sqlSchema,
};

/**
 * Identity of a question, for "have we generated this one already".
 *
 * Prompt wording drifts between generations; what a question *asks* does not.
 * MCQs are identified by their stem and answer key, coding questions by the
 * class they ask for and the behaviour they check.
 *
 * `kind` leads, and must: a debug exercise is a verified machine-coding question
 * with a bug planted in it, so the two share a class, a statement and a test
 * suite. Without the kind, storing the debug question silently overwrites the
 * very question it was built from.
 */
export function fingerprint(question) {
  const normalise = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const parts = question.kind === 'mcq'
    ? [question.prompt, ...[...question.correctAnswers].sort()]
    : question.kind === 'sql'
      ? [question.statement, question.referenceQuery]
      : [question.entity.name, question.statement, ...question.entity.methods.map((method) => method.name).sort()];
  return crypto.createHash('sha256').update([question.kind, ...parts.map(normalise)].join('|')).digest('hex').slice(0, 32);
}
