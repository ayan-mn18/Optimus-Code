import { HARNESS_NOTE } from './shared.js';

const CPP_HEADERS = `#include <algorithm>
#include <cmath>
#include <cstdio>
#include <iomanip>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>`;

// Keep the starter runnable through the same source guard as a submitted
// answer. The harness needs snprintf for its JSON line, but student code does
// not need stdio (and stdio would make file access easier to smuggle in).
const CPP_STARTER_HEADERS = CPP_HEADERS.replace('#include <cstdio>\n', '');

/** Split the top-level arguments of a vocabulary type such as map<string,list<int>>. */
function generic(type, name) {
  const prefix = `${name}<`;
  if (!type.startsWith(prefix) || !type.endsWith('>')) return null;
  const inner = type.slice(prefix.length, -1);
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < inner.length; index += 1) {
    if (inner[index] === '<') depth += 1;
    if (inner[index] === '>') depth -= 1;
    if (inner[index] === ',' && depth === 0) {
      parts.push(inner.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(inner.slice(start).trim());
  return parts;
}

function cppType(type) {
  if (type === 'void') return 'void';
  const scalar = { int: 'int', long: 'long long', double: 'double', bool: 'bool', string: 'std::string' };
  if (scalar[type]) return scalar[type];
  const list = generic(type, 'list');
  if (list?.length === 1) return `std::vector<${cppType(list[0])}>`;
  const map = generic(type, 'map');
  if (map?.length === 2) return `std::map<${cppType(map[0])}, ${cppType(map[1])}>`;
  throw new Error(`C++ type unsupported: ${type}`);
}

function quote(value) {
  let out = '"';
  for (const char of String(value)) {
    if (char === '\\') out += '\\\\';
    else if (char === '"') out += '\\"';
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (char.charCodeAt(0) < 0x20) out += `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
    else out += char;
  }
  return `${out}"`;
}

function zero(type) {
  if (type === 'void') return '';
  if (type === 'bool') return 'false';
  if (type === 'int') return '0';
  if (type === 'long') return '0LL';
  if (type === 'double') return '0.0';
  if (type === 'string') return 'std::string{}';
  if (generic(type, 'list') || generic(type, 'map')) return '{}';
  throw new Error(`C++ zero value unsupported: ${type}`);
}

function literal(value, type) {
  if (value === null || value === undefined) return zero(type) || '{}';
  if (type === 'string') return quote(value);
  if (type === 'bool') return value ? 'true' : 'false';
  if (type === 'int') return String(Math.trunc(Number(value)));
  if (type === 'long') return `${Math.trunc(Number(value))}LL`;
  if (type === 'double') return Number.isInteger(Number(value)) ? `${value}.0` : String(value);

  const list = generic(type, 'list');
  if (list?.length === 1) return `{${(Array.isArray(value) ? value : []).map((item) => literal(item, list[0])).join(', ')}}`;

  const map = generic(type, 'map');
  if (map?.length === 2) {
    const entries = Object.entries(value && typeof value === 'object' ? value : {})
      .map(([key, item]) => `{${literal(map[0] === 'string' ? key : Number(key), map[0])}, ${literal(item, map[1])}}`);
    return `{${entries.join(', ')}}`;
  }
  throw new Error(`C++ literal unsupported: ${type}`);
}

function methodCall(entity, method, step) {
  const args = method.params.map((param, index) => literal(step.args?.[index], param.type)).join(', ');
  return `inst.${method.name}(${args})`;
}

function testBlock(entity, test) {
  const methods = new Map(entity.methods.map((method) => [method.name, method]));
  const construct = test.steps[0];
  const constructorArgs = entity.constructorParams
    .map((param, position) => literal(construct.args?.[position], param.type)).join(', ');
  // Avoid C++'s most-vexing parse for a zero-argument constructor: `Thing
  // inst();` declares a function instead of an instance.
  const construction = constructorArgs ? `${entity.name} inst(${constructorArgs});` : `${entity.name} inst;`;
  const lines = [`      ${construction}`];
  let stepIndex = 0;

  for (const step of test.steps.slice(1)) {
    const method = methods.get(step.op);
    if (!method) throw new Error(`Test references unknown method ${step.op}`);
    const call = methodCall(entity, method, step);
    if (step.throws) {
      lines.push(`      { bool raised${stepIndex} = false;`);
      lines.push(`        try { ${call}; } catch (...) { raised${stepIndex} = true; }`);
      lines.push(`        if (!raised${stepIndex}) throw Mismatch(${quote(step.op)}, "an error", "no error"); }`);
    } else if (Object.hasOwn(step, 'expect') && method.returns !== 'void') {
      lines.push(`      { auto actual${stepIndex} = ${call};`);
      lines.push(`        if (canon(actual${stepIndex}) != ${quote(step.expect)}) throw Mismatch(${quote(step.op)}, ${quote(step.expect)}, canon(actual${stepIndex})); }`);
    } else {
      lines.push(`      ${call};`);
    }
    stepIndex += 1;
  }

  return `    {
      try {
${lines.join('\n')}
        emit(${quote(test.name)}, true, "", "", "", "");
      } catch (const Mismatch& mismatch) {
        emit(${quote(test.name)}, false, mismatch.step, mismatch.expected, mismatch.actual, "");
      } catch (const std::exception& error) {
        emit(${quote(test.name)}, false, "", "", "", error.what());
      } catch (...) {
        emit(${quote(test.name)}, false, "", "", "", "unknown exception");
      }
    }`;
}

const main = (entity, tests, marker) => String.raw`// ${HARNESS_NOTE}
${CPP_HEADERS}
using namespace std;
#include "${entity.name}.cpp"

struct Mismatch {
    string step, expected, actual;
    Mismatch(string s, string e, string a) : step(std::move(s)), expected(std::move(e)), actual(std::move(a)) {}
};

static string jq(const string& value) {
    string out = "\"";
    for (unsigned char c : value) {
        if (c == '\\') out += "\\\\";
        else if (c == '"') out += "\\\"";
        else if (c == '\n') out += "\\n";
        else if (c == '\r') out += "\\r";
        else if (c == '\t') out += "\\t";
        else if (c < 0x20) { char buffer[8]; snprintf(buffer, sizeof(buffer), "\\u%04x", c); out += buffer; }
        else out += static_cast<char>(c);
    }
    return out + "\"";
}

static string canon(const string& value) { return jq(value); }
static string canon(const char* value) { return jq(value ? string(value) : string()); }
static string canon(bool value) { return value ? "true" : "false"; }
static string canon(nullptr_t) { return "null"; }

template <typename T, enable_if_t<is_integral_v<T> && !is_same_v<T, bool>, int> = 0>
static string canon(T value) { return to_string(value); }

template <typename T, enable_if_t<is_floating_point_v<T>, int> = 0>
static string canon(T value) {
    if (!isfinite(value)) return "null";
    if (value == trunc(value) && fabs(value) < 9.0e15) return to_string(static_cast<long long>(value));
    ostringstream stream;
    stream << fixed << setprecision(6) << value;
    string output = stream.str();
    while (!output.empty() && output.back() == '0') output.pop_back();
    if (!output.empty() && output.back() == '.') output.pop_back();
    return output == "-0" ? "0" : output;
}

template <typename T>
static string canon(const vector<T>& value) {
    string output = "[";
    for (size_t index = 0; index < value.size(); index += 1) {
        if (index) output += ',';
        output += canon(value[index]);
    }
    return output + ']';
}

static string mapKey(const string& value) { return value; }
template <typename T, enable_if_t<is_integral_v<T>, int> = 0>
static string mapKey(T value) { return to_string(value); }

template <typename K, typename V>
static string canon(const map<K, V>& value) {
    vector<pair<string, string>> entries;
    for (const auto& [key, item] : value) entries.emplace_back(mapKey(key), canon(item));
    sort(entries.begin(), entries.end(), [](const auto& left, const auto& right) { return left.first < right.first; });
    string output = "{";
    for (size_t index = 0; index < entries.size(); index += 1) {
        if (index) output += ',';
        output += jq(entries[index].first) + ':' + entries[index].second;
    }
    return output + '}';
}

static void emit(const string& name, bool passed, const string& step, const string& expected, const string& actual, const string& error) {
    static bool first = true;
    if (!first) cout << ',';
    first = false;
    cout << "{\"name\":" << jq(name) << ",\"passed\":" << (passed ? "true" : "false");
    if (!step.empty()) cout << ",\"step\":" << jq(step);
    if (!expected.empty()) cout << ",\"expected\":" << jq(expected);
    if (!actual.empty()) cout << ",\"actual\":" << jq(actual);
    if (!error.empty()) cout << ",\"error\":" << jq(error.substr(0, 300));
    cout << '}';
}

int main() {
    cout << ${quote(marker)} << '[';
${tests.map((test) => testBlock(entity, test)).join('\n')}
    cout << "]\\n";
}
`;

export const cpp = {
  id: 'cpp',
  label: 'C++',
  monaco: 'cpp',
  judge0Id: 54, // C++ (GCC 9.2.0) on the production Judge0 VM
  runtimeId: 54,
  packaging: 'multi',
  denylist: [
    /#\s*include\s*[<"](?:fstream|filesystem|cstdlib|cstdio|netinet|sys\/|unistd)/i,
    /\b(?:system|popen|fork|exec(?:l|le|lp|v|ve|vp)?|freopen)\s*\(/,
    /\b(?:std::)?(?:ifstream|ofstream|fstream)\b/,
    /\b(?:std::)?filesystem::/,
    /\b(?:asm|__asm__)\b/,
  ],

  denyMessage: (found) => `This assessment runs offline, so \`${found}\` is not available. Solve it with plain data structures.`,

  starter({ entity }) {
    const params = entity.constructorParams.map((param) => `${cppType(param.type)} ${param.name}`).join(', ');
    const methods = entity.methods.map((method) => {
      const signature = method.params.map((param) => `${cppType(param.type)} ${param.name}`).join(', ');
      const body = method.returns === 'void' ? '        // TODO\n' : `        // TODO\n        return ${zero(method.returns)};\n`;
      return `    ${cppType(method.returns)} ${method.name}(${signature}) {\n${body}    }\n`;
    }).join('\n');
    return `${CPP_STARTER_HEADERS}\nusing namespace std;\n\nclass ${entity.name} {\npublic:\n    ${entity.name}(${params}) {\n        // TODO\n    }\n\n${methods}};\n`;
  },

  buildProgram({ entity, tests, source, marker }) {
    return {
      files: [
        { name: `${entity.name}.cpp`, content: source },
        { name: 'main.cpp', content: main(entity, tests, marker) },
        { name: 'compile', content: '#!/usr/bin/env bash\ng++ -std=c++17 -O2 -pipe main.cpp -o main\n' },
        { name: 'run', content: '#!/usr/bin/env bash\n./main\n' },
      ],
    };
  },
};
