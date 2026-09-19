import { HARNESS_NOTE } from './shared.js';

export const javascript = {
  id: 'javascript',
  label: 'JavaScript',
  monaco: 'javascript',
  judge0Id: 102,
  packaging: 'single',
  filename: 'main.js',
  denylist: [
    /\brequire\s*\(\s*['"](fs|net|http|https|child_process|dgram|vm|worker_threads|os|cluster)['"]\s*\)/,
    /\bimport\s+.*\bfrom\s+['"](node:)?(fs|net|http|https|child_process|vm|worker_threads|os)['"]/,
    /\bprocess\s*\.\s*(exit|binding|dlopen|env)\b/,
    /\bglobalThis\s*\[/,
    /\beval\s*\(|new\s+Function\s*\(/,
  ],

  denyMessage: (found) => `This assessment runs offline, so \`${found}\` is not available. Solve it with plain data structures.`,

  starter({ entity }) {
    const args = entity.constructorParams.map((param) => param.name).join(', ');
    const methods = entity.methods.map((method) => {
      const params = method.params.map((param) => param.name).join(', ');
      return `  ${method.name}(${params}) {\n    // TODO\n  }\n`;
    }).join('\n');
    return `class ${entity.name} {\n  constructor(${args}) {\n    // TODO\n  }\n\n${methods}}\n`;
  },

  buildProgram({ entity, tests, source, marker }) {
    const payload = Buffer.from(JSON.stringify(tests), 'utf8').toString('base64');
    return {
      source: `${source}\n\n${harness(entity, payload, marker)}`,
    };
  },
};

const harness = (entity, payload, marker) => `
// ${HARNESS_NOTE}
(() => {
  const canon = (v) => {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return 'null';
      if (Number.isInteger(v)) return String(v);
      const trimmed = v.toFixed(6).replace(/0+$/, '').replace(/\\.$/, '');
      return trimmed === '-0' ? '0' : trimmed;
    }
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v instanceof Set) return '[' + [...v].map(canon).join(',') + ']';
    if (v instanceof Map) {
      const keys = [...v.keys()].map(String).sort();
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(v.get(k))).join(',') + '}';
    }
    if (typeof v === 'object') {
      const keys = Object.keys(v).sort();
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
    }
    return JSON.stringify(String(v));
  };

  const Entity = typeof ${entity.name} !== 'undefined'
    ? ${entity.name}
    : (typeof module !== 'undefined' && module.exports && (module.exports.${entity.name} || module.exports));

  const tests = JSON.parse(Buffer.from('${payload}', 'base64').toString('utf8'));
  const results = [];
  for (const test of tests) {
    const entry = { name: test.name, passed: true };
    try {
      if (typeof Entity !== 'function') throw new Error('class ${entity.name} is not defined');
      let instance = null;
      for (const step of test.steps) {
        if (step.op === 'new') { instance = new Entity(...(step.args ?? [])); continue; }
        if (typeof instance[step.op] !== 'function') throw new Error('${entity.name} has no method ' + step.op);
        if (step.throws) {
          let raised = false;
          try { instance[step.op](...(step.args ?? [])); } catch { raised = true; }
          if (!raised) {
            Object.assign(entry, { passed: false, step: step.op, expected: 'an error', actual: 'no error' });
            break;
          }
          continue;
        }
        const actual = instance[step.op](...(step.args ?? []));
        if ('expect' in step) {
          const got = canon(actual);
          if (got !== step.expect) {
            Object.assign(entry, { passed: false, step: step.op, expected: step.expect, actual: got });
            break;
          }
        }
      }
    } catch (error) {
      Object.assign(entry, { passed: false, error: String((error && error.message) || error).slice(0, 300) });
    }
    results.push(entry);
  }
  process.stdout.write('${marker}' + JSON.stringify(results) + '\\n');
})();
`;
