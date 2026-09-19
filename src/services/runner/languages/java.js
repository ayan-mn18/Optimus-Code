import { HARNESS_NOTE } from './shared.js';

/**
 * Java needs a compiler, several files, and no JSON library, so its harness is
 * generated rather than interpreted: we know every signature from the question's
 * `entity`, so we emit straight-line, statically typed calls. The upshot is that
 * a wrong signature fails at compile time with javac's own error message, which
 * is a far better hint than a reflection stack trace.
 */

const SCALARS = {
  int: { java: 'int', boxed: 'Integer' },
  long: { java: 'long', boxed: 'Long' },
  double: { java: 'double', boxed: 'Double' },
  bool: { java: 'boolean', boxed: 'Boolean' },
  string: { java: 'String', boxed: 'String' },
};

export function javaType(type) {
  if (type === 'void') return 'void';
  if (SCALARS[type]) return SCALARS[type].java;
  const list = /^list<(.+)>$/.exec(type);
  if (list) return `List<${boxed(list[1])}>`;
  const map = /^map<([a-z]+),\s*(.+)>$/.exec(type);
  if (map) return `Map<${boxed(map[1])}, ${boxed(map[2])}>`;
  return 'Object';
}

function boxed(type) {
  if (SCALARS[type]) return SCALARS[type].boxed;
  const list = /^list<(.+)>$/.exec(type);
  if (list) return `List<${boxed(list[1])}>`;
  const map = /^map<([a-z]+),\s*(.+)>$/.exec(type);
  if (map) return `Map<${boxed(map[1])}, ${boxed(map[2])}>`;
  return 'Object';
}

function quote(value) {
  return `"${String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`;
}

/** A JSON value from the question, rendered as a Java literal of its declared type. */
export function literal(value, type) {
  if (value === null || value === undefined) return 'null';
  if (SCALARS[type]) {
    if (type === 'string') return quote(value);
    if (type === 'bool') return value ? 'true' : 'false';
    if (type === 'long') return `${Math.trunc(value)}L`;
    if (type === 'double') return Number.isInteger(value) ? `${value}.0` : String(value);
    return String(Math.trunc(value));
  }
  const list = /^list<(.+)>$/.exec(type);
  if (list) {
    const element = boxed(list[1]);
    const items = (value ?? []).map((item) => literal(item, list[1]));
    return `java.util.Arrays.<${element}>asList(${items.join(', ')})`;
  }
  const map = /^map<([a-z]+),\s*(.+)>$/.exec(type);
  if (map) {
    const [, keyType, valueType] = map;
    const entries = Object.entries(value ?? {})
      .flatMap(([key, item]) => [literal(keyType === 'string' ? key : Number(key), keyType), literal(item, valueType)]);
    return `Main.<${boxed(keyType)}, ${boxed(valueType)}>map(${entries.join(', ')})`;
  }
  // The question schema admits nothing else, so anything here is a generator
  // bug rather than something a student did.
  throw new Error(`Java literal unsupported for type ${type}`);
}

export const java = {
  id: 'java',
  label: 'Java',
  monaco: 'java',
  judge0Id: 89,          // multi-file program
  runtimeId: 91,         // JDK 17, for reference in the UI
  packaging: 'multi',
  denylist: [
    /\bjava\s*\.\s*(net|nio\s*\.\s*file|io\s*\.\s*File)\b/,
    /\bSystem\s*\.\s*exit\b/,
    /\bRuntime\s*\.\s*getRuntime\b/,
    /\bProcessBuilder\b/,
    /\bClass\s*\.\s*forName\b/,
    /\bgetDeclaredMethods?\b|\bsetAccessible\b/,
  ],

  denyMessage: (found) => `This assessment runs offline, so \`${found}\` is not available. Solve it with plain data structures.`,

  starter({ entity }) {
    const params = entity.constructorParams.map((param) => `${javaType(param.type)} ${param.name}`).join(', ');
    const methods = entity.methods.map((method) => {
      const signature = method.params.map((param) => `${javaType(param.type)} ${param.name}`).join(', ');
      const body = method.returns === 'void' ? '        // TODO\n' : `        // TODO\n        return ${zero(method.returns)};\n`;
      return `    public ${javaType(method.returns)} ${method.name}(${signature}) {\n${body}    }\n`;
    }).join('\n');
    return `import java.util.*;\n\npublic class ${entity.name} {\n    public ${entity.name}(${params}) {\n        // TODO\n    }\n\n${methods}}\n`;
  },

  buildProgram({ entity, tests, source, marker }) {
    return {
      files: [
        { name: `${entity.name}.java`, content: source },
        { name: 'Main.java', content: main(entity, tests, marker) },
        { name: 'compile', content: `#!/usr/bin/env bash\njavac -nowarn ${entity.name}.java Main.java\n` },
        { name: 'run', content: '#!/usr/bin/env bash\njava Main\n' },
      ],
    };
  },
};

function zero(type) {
  if (type === 'bool') return 'false';
  if (type === 'int' || type === 'long') return '0';
  if (type === 'double') return '0.0';
  return 'null';
}

function testBlock(entity, test, index) {
  const byName = new Map(entity.methods.map((method) => [method.name, method]));
  const lines = [];
  let step = 0;

  for (const item of test.steps) {
    if (item.op === 'new') {
      const args = entity.constructorParams.map((param, position) => literal(item.args?.[position], param.type));
      lines.push(`      ${entity.name} inst = new ${entity.name}(${args.join(', ')});`);
      continue;
    }
    const method = byName.get(item.op);
    if (!method) throw new Error(`Test references unknown method ${item.op}`);
    const args = method.params.map((param, position) => literal(item.args?.[position], param.type));
    const call = `inst.${item.op}(${args.join(', ')})`;
    if (item.throws) {
      lines.push(`      { boolean raised${step} = false;`);
      lines.push(`        try { ${call}; } catch (Throwable thrown) { raised${step} = true; }`);
      lines.push(`        if (!raised${step}) throw new Mismatch(${quote(item.op)}, "an error", "no error"); }`);
      step += 1;
      continue;
    }
    if (method.returns === 'void' || item.expect === undefined) {
      lines.push(`      ${call};`);
    } else {
      lines.push(`      { Object a${step} = ${call}; String c${step} = canon(a${step});`);
      lines.push(`        if (!c${step}.equals(${quote(item.expect)})) throw new Mismatch(${quote(item.op)}, ${quote(item.expect)}, c${step}); }`);
    }
    step += 1;
  }

  const name = quote(test.name);
  return `    // test ${index}
    try {
${lines.join('\n')}
      emit(${name}, true, null, null, null, null);
    } catch (Mismatch m) {
      emit(${name}, false, m.step, m.expected, m.actual, null);
    } catch (Throwable t) {
      emit(${name}, false, null, null, null, t.getClass().getSimpleName() + ": " + String.valueOf(t.getMessage()));
    }`;
}

const main = (entity, tests, marker) => `// ${HARNESS_NOTE}
import java.util.*;

public class Main {
    static final StringBuilder OUT = new StringBuilder();
    static boolean first = true;

    static class Mismatch extends RuntimeException {
        final String step, expected, actual;
        Mismatch(String step, String expected, String actual) {
            super("mismatch");
            this.step = step; this.expected = expected; this.actual = actual;
        }
    }

    @SuppressWarnings("unchecked")
    static <K, V> Map<K, V> map(Object... pairs) {
        Map<K, V> built = new LinkedHashMap<>();
        for (int i = 0; i + 1 < pairs.length; i += 2) built.put((K) pairs[i], (V) pairs[i + 1]);
        return built;
    }

    static String jq(String value) {
        StringBuilder sb = new StringBuilder("\\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '"' || c == '\\\\') sb.append('\\\\').append(c);
            else if (c == '\\n') sb.append("\\\\n");
            else if (c == '\\r') sb.append("\\\\r");
            else if (c == '\\t') sb.append("\\\\t");
            else if (c < 0x20) sb.append(String.format("\\\\u%04x", (int) c));
            else sb.append(c);
        }
        return sb.append('"').toString();
    }

    static String canon(Object v) {
        if (v == null) return "null";
        if (v instanceof Boolean) return ((Boolean) v) ? "true" : "false";
        if (v instanceof Double || v instanceof Float) {
            double d = ((Number) v).doubleValue();
            if (Double.isNaN(d) || Double.isInfinite(d)) return "null";
            if (d == Math.rint(d) && Math.abs(d) < 9.0e15) return String.valueOf((long) d);
            String s = String.format(Locale.ROOT, "%.6f", d).replaceAll("0+$", "").replaceAll("\\\\.$", "");
            return s.equals("-0") ? "0" : s;
        }
        if (v instanceof Number) return v.toString();
        if (v instanceof Character || v instanceof String) return jq(v.toString());
        if (v instanceof Map) {
            Map<?, ?> map = (Map<?, ?>) v;
            List<String> keys = new ArrayList<>();
            for (Object key : map.keySet()) keys.add(String.valueOf(key));
            Collections.sort(keys);
            StringBuilder sb = new StringBuilder("{");
            for (int i = 0; i < keys.size(); i++) {
                if (i > 0) sb.append(',');
                Object value = null;
                for (Map.Entry<?, ?> entry : map.entrySet()) {
                    if (String.valueOf(entry.getKey()).equals(keys.get(i))) { value = entry.getValue(); break; }
                }
                sb.append(jq(keys.get(i))).append(':').append(canon(value));
            }
            return sb.append('}').toString();
        }
        if (v instanceof Iterable) {
            StringBuilder sb = new StringBuilder("[");
            boolean firstItem = true;
            for (Object item : (Iterable<?>) v) {
                if (!firstItem) sb.append(',');
                sb.append(canon(item));
                firstItem = false;
            }
            return sb.append(']').toString();
        }
        if (v.getClass().isArray()) {
            int length = java.lang.reflect.Array.getLength(v);
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < length; i++) {
                if (i > 0) sb.append(',');
                sb.append(canon(java.lang.reflect.Array.get(v, i)));
            }
            return sb.append(']').toString();
        }
        return jq(String.valueOf(v));
    }

    static void emit(String name, boolean passed, String step, String expected, String actual, String error) {
        if (!first) OUT.append(',');
        first = false;
        OUT.append('{').append(jq("name")).append(':').append(jq(name));
        OUT.append(',').append(jq("passed")).append(':').append(passed ? "true" : "false");
        if (step != null) OUT.append(',').append(jq("step")).append(':').append(jq(step));
        if (expected != null) OUT.append(',').append(jq("expected")).append(':').append(jq(expected));
        if (actual != null) OUT.append(',').append(jq("actual")).append(':').append(jq(actual));
        if (error != null) OUT.append(',').append(jq("error")).append(':').append(jq(error.length() > 300 ? error.substring(0, 300) : error));
        OUT.append('}');
    }

    public static void main(String[] argv) {
${tests.map((test, index) => testBlock(entity, test, index)).join('\n')}
        System.out.println("${marker}" + "[" + OUT + "]");
    }
}
`;
