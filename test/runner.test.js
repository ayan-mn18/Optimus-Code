import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { canonical } from '../src/services/runner/canonical.js';
import { createZip } from '../src/services/runner/zip.js';
import { literal, javaType } from '../src/services/runner/languages/java.js';
import { normaliseResultSet } from '../src/services/runner/languages/sql.js';
import {
  buildSubmissions, guardSource, getLanguage, newMarker, parseMarkerOutput, prepareTests,
} from '../src/services/runner/index.js';
import { runAnswer, redactResults } from '../src/services/runner/grade.js';

const QUESTION = {
  entity: {
    name: 'LruCache',
    constructorParams: [{ name: 'capacity', type: 'int' }],
    methods: [
      { name: 'put', params: [{ name: 'key', type: 'string' }, { name: 'value', type: 'int' }], returns: 'void' },
      { name: 'get', params: [{ name: 'key', type: 'string' }], returns: 'int' },
    ],
  },
  tests: [
    { name: 'visible one', visible: true, steps: [{ op: 'new', args: [2] }, { op: 'get', args: ['a'], expect: -1 }] },
    { name: 'hidden one', visible: false, steps: [{ op: 'new', args: [1] }, { op: 'get', args: ['b'], expect: -1 }] },
  ],
};

test('canonical form is stable across shapes a harness might produce', () => {
  assert.equal(canonical({ b: 1, a: [1, 2.5, null] }), '{"a":[1,2.5,null],"b":1}');
  assert.equal(canonical(2.0), '2');
  assert.equal(canonical(1 / 3), '0.333333');
  assert.equal(canonical(-0.0000001), '0');
  assert.equal(canonical(Number.POSITIVE_INFINITY), 'null');
  assert.equal(canonical('a"b'), '"a\\"b"');
  assert.equal(canonical(undefined), 'null');
});

test('zip archives are readable and hold every file', () => {
  const files = [{ name: 'run', content: '#!/usr/bin/env bash\njava Main\n' }, { name: 'A.java', content: 'class A {}\n'.repeat(40) }];
  const archive = createZip(files);
  assert.equal(archive.subarray(0, 4).toString('latin1'), 'PK\u0003\u0004');

  // Walk the local headers back out and inflate what we stored.
  let offset = 0;
  const seen = new Map();
  while (archive.readUInt32LE(offset) === 0x04034b50) {
    const method = archive.readUInt16LE(offset + 8);
    const compressed = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const name = archive.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength;
    const payload = archive.subarray(start, start + compressed);
    seen.set(name, method === 8 ? zlib.inflateRawSync(payload).toString('utf8') : payload.toString('utf8'));
    offset = start + compressed;
  }
  assert.deepEqual([...seen.keys()], ['run', 'A.java']);
  assert.equal(seen.get('run'), files[0].content);
  assert.equal(seen.get('A.java'), files[1].content);
});

test('java codegen renders literals and types for the closed vocabulary', () => {
  assert.equal(literal(3, 'int'), '3');
  assert.equal(literal(3, 'long'), '3L');
  assert.equal(literal(3, 'double'), '3.0');
  assert.equal(literal(true, 'bool'), 'true');
  assert.equal(literal('a"b', 'string'), '"a\\"b"');
  assert.equal(literal([1, 2], 'list<int>'), 'java.util.Arrays.<Integer>asList(1, 2)');
  assert.equal(literal([], 'list<string>'), 'java.util.Arrays.<String>asList()');
  assert.equal(literal(null, 'int'), 'null');
  assert.equal(javaType('map<string,int>'), 'Map<String, Integer>');
  assert.equal(javaType('void'), 'void');
  // One level of nesting has to keep its generics, or the call site will not
  // compile against the student's declared signature.
  assert.equal(javaType('list<map<string,int>>'), 'List<Map<String, Integer>>');
  assert.equal(literal({ a: [1, 2] }, 'map<string,list<int>>'), 'Main.<String, List<Integer>>map("a", java.util.Arrays.<Integer>asList(1, 2))');
  // An index-keyed map keeps integer keys rather than being stringified.
  assert.equal(javaType('map<int,int>'), 'Map<Integer, Integer>');
  assert.equal(literal({ 0: 5, 1: 6 }, 'map<int,int>'), 'Main.<Integer, Integer>map(0, 5, 1, 6)');
  assert.equal(literal([[1], [2]], 'list<list<int>>'), 'java.util.Arrays.<List<Integer>>asList(java.util.Arrays.<Integer>asList(1), java.util.Arrays.<Integer>asList(2))');
});

test('source guard blocks escapes and oversized answers', () => {
  assert.throws(() => guardSource(getLanguage('python'), 'import os\n'), /not available/);
  assert.throws(() => guardSource(getLanguage('javascript'), "require('fs')"), /not available/);
  assert.throws(() => guardSource(getLanguage('java'), 'Runtime.getRuntime().exec("x")'), /not available/);
  assert.throws(() => guardSource(getLanguage('sql'), 'DELETE FROM orders'), /single SELECT/);
  assert.throws(() => guardSource(getLanguage('python'), 'x = 1\n'.repeat(20_000)), /50 KB/);
  assert.throws(() => guardSource(getLanguage('python'), '   '), /Write some code/);
  assert.doesNotThrow(() => guardSource(getLanguage('python'), 'class A:\n    pass\n'));
  assert.doesNotThrow(() => guardSource(getLanguage('cpp'), getLanguage('cpp').starter({ entity: QUESTION.entity })));
  assert.throws(() => guardSource(getLanguage('cpp'), '#include <fstream>\n'), /not available/);
});

test('a practice run cannot contain the hidden tests', () => {
  const visibleOnly = prepareTests(QUESTION, { includeHidden: false });
  assert.equal(visibleOnly.length, 1);
  assert.equal(visibleOnly[0].name, 'visible one');
  // Expectations reach the harness already canonicalised.
  assert.equal(visibleOnly[0].steps[1].expect, '-1');

  const marker = newMarker();
  const [submission] = buildSubmissions({
    question: QUESTION, languageId: 'python', source: 'class LruCache:\n    pass\n', tests: visibleOnly, marker,
  });
  assert.match(submission.judge0.source_code, /class LruCache/);
  assert.equal(submission.judge0.source_code.includes('hidden one'), false);
  assert.match(submission.judge0.source_code, new RegExp(marker));
});

test('java submissions ship the student file, the harness, and both scripts', () => {
  const [submission] = buildSubmissions({
    question: QUESTION,
    languageId: 'java',
    source: 'public class LruCache { public LruCache(int c) {} public void put(String k, int v) {} public int get(String k) { return -1; } }',
    tests: prepareTests(QUESTION, { includeHidden: true }),
    marker: newMarker(),
  });
  assert.equal(submission.judge0.language_id, 89);
  const archive = Buffer.from(submission.judge0.additional_files, 'base64');
  const text = archive.toString('latin1');
  for (const name of ['LruCache.java', 'Main.java', 'compile', 'run']) assert.ok(text.includes(name), `${name} missing`);
});

test('cpp submissions use Judge0 GCC and ship the student file, harness, and scripts', () => {
  const [submission] = buildSubmissions({
    question: QUESTION,
    languageId: 'cpp',
    source: '#include <string>\nclass LruCache { public: LruCache(int) {} int get(std::string) { return -1; } };',
    tests: prepareTests(QUESTION, { includeHidden: true }),
    marker: newMarker(),
  });
  assert.equal(submission.judge0.language_id, 54);
  assert.match(submission.judge0.source_code, /int main\(\)/);
  const archive = Buffer.from(submission.judge0.additional_files, 'base64');
  const text = archive.toString('latin1');
  for (const name of ['LruCache.cpp', 'main.cpp', 'compile', 'run']) assert.ok(text.includes(name), `${name} missing`);
});

test('result lines are trusted only when there is exactly one', () => {
  const marker = newMarker();
  const tests = prepareTests(QUESTION, { includeHidden: true });
  const line = `${marker}[{"name":"visible one","passed":true},{"name":"hidden one","passed":true}]`;

  assert.equal(parseMarkerOutput(`noise\n${line}\n`, marker, tests).length, 2);
  assert.equal(parseMarkerOutput('nothing here', marker, tests), null);
  assert.equal(parseMarkerOutput(`${marker}not json`, marker, tests), null);
  // A forged line plus the real one is a forgery, not a pass.
  assert.throws(() => parseMarkerOutput(`${line}\n${line}`, marker, tests), /printed the grader/);
});

test('sql result sets ignore row order only when the question does', () => {
  assert.equal(normaliseResultSet('b|2\na|1\n\n', { orderMatters: false }), 'a|1\nb|2');
  assert.equal(normaliseResultSet('b|2\na|1', { orderMatters: true }), 'b|2\na|1');
  assert.equal(normaliseResultSet('a|1   \n', { orderMatters: true }), 'a|1');
});

const fakeTransport = (stdout, extra = {}) => ({
  execute: async () => ({
    stdout, stderr: '', compileOutput: '', message: null, status: { description: 'Accepted' }, time: '0.01', memory: 1024, ...extra,
  }),
});

test('grading reports per-test outcomes and a ratio', async () => {
  let captured;
  const transport = {
    execute: async (body) => {
      captured = body;
      const marker = /__OPTIMUS_[0-9A-F]+__/.exec(body.source_code)[0];
      return {
        stdout: `${marker}[{"name":"visible one","passed":false,"step":"get","expected":"-1","actual":"0"},{"name":"hidden one","passed":false,"step":"get","expected":"-1","actual":"7"}]`,
        stderr: '', compileOutput: '', message: null, status: { description: 'Accepted' }, time: '0.02', memory: 2048,
      };
    },
  };
  const result = await runAnswer({ question: QUESTION, languageId: 'python', source: 'class LruCache:\n    pass\n', includeHidden: true, transport });
  assert.equal(result.passed, false);
  assert.equal(result.passedCount, 0);
  assert.equal(result.total, 2);
  assert.equal(result.ratio, 0);
  assert.equal(captured.language_id, 100);

  // A visible failure keeps its detail; a hidden one is reduced to its name.
  const redacted = redactResults(result.results);
  assert.equal(redacted[0].expected, '-1');
  assert.equal(redacted[0].actual, '0');
  assert.deepEqual(redacted[1], { name: 'hidden one', visible: false, passed: false });
});

test('a program that never reaches the harness fails every test with the compiler error', async () => {
  const transport = fakeTransport('', { compileOutput: 'Main.java:4: error: cannot find symbol', status: { description: 'Compilation Error' } });
  const result = await runAnswer({ question: QUESTION, languageId: 'python', source: 'class LruCache:\n    pass\n', includeHidden: true, transport });
  assert.equal(result.passedCount, 0);
  assert.equal(result.total, 2);
  assert.match(result.results[0].error, /cannot find symbol/);
});

test('sql grading compares normalised result sets seed by seed', async () => {
  const question = {
    schema: 'CREATE TABLE t (a INT);',
    orderMatters: false,
    tests: [
      { name: 'sample', visible: true, seed: 'INSERT INTO t VALUES (1);', expectedStdout: '1' },
      { name: 'hidden', visible: false, seed: 'INSERT INTO t VALUES (2);', expectedStdout: '9' },
    ],
  };
  const transport = { execute: async (body) => ({ stdout: body.source_code.includes('(1)') ? '1\n' : '2\n', stderr: '', compileOutput: '', status: { description: 'Accepted' } }) };
  const result = await runAnswer({ question, languageId: 'sql', source: 'SELECT a FROM t', includeHidden: true, transport });
  assert.equal(result.passedCount, 1);
  assert.equal(result.results[1].passed, false);
});
