import { HARNESS_NOTE } from './shared.js';

export const python = {
  id: 'python',
  label: 'Python',
  monaco: 'python',
  judge0Id: 100,
  packaging: 'single',
  filename: 'main.py',
  // Blocks the escapes, not the language. Everything here is unreachable from a
  // correct answer to a data-structure question.
  denylist: [
    /\bimport\s+(os|sys|socket|subprocess|shutil|ctypes|multiprocessing)\b/,
    /\bfrom\s+(os|sys|socket|subprocess|shutil|ctypes)\s+import\b/,
    /\b__import__\s*\(/,
    /\bopen\s*\(/,
    /\beval\s*\(|\bexec\s*\(/,
    // Reading our own source would expose the harness marker and the tests.
    /\b__loader__\b|\binspect\b|\blinecache\b/,
  ],

  denyMessage: (found) => `This assessment runs offline, so \`${found}\` is not available. Solve it with plain data structures.`,

  starter({ entity }) {
    const args = entity.constructorParams.map((param) => param.name).join(', ');
    const methods = entity.methods.map((method) => {
      const params = ['self', ...method.params.map((param) => param.name)].join(', ');
      return `    def ${method.name}(${params}):\n        # TODO\n        pass\n`;
    }).join('\n');
    return `class ${entity.name}:\n    def __init__(self${args ? `, ${args}` : ''}):\n        # TODO\n        pass\n\n${methods}`;
  },

  buildProgram({ entity, tests, source, marker }) {
    const payload = Buffer.from(JSON.stringify(tests), 'utf8').toString('base64');
    return {
      source: `${source}\n\n${harness(entity, payload, marker)}`,
    };
  },
};

const harness = (entity, payload, marker) => `
# ${HARNESS_NOTE}
import json as _oj, base64 as _ob, re as _ore, traceback as _otb

def _ocanon(v):
    if v is None: return 'null'
    if isinstance(v, bool): return 'true' if v else 'false'
    if isinstance(v, int): return str(v)
    if isinstance(v, float):
        if v != v or v in (float('inf'), float('-inf')): return 'null'
        if v == int(v): return str(int(v))
        s = ('%.6f' % v).rstrip('0').rstrip('.')
        return '0' if s == '-0' else s
    if isinstance(v, str): return _oj.dumps(v, ensure_ascii=False)
    if isinstance(v, (list, tuple)): return '[' + ','.join(_ocanon(x) for x in v) + ']'
    if isinstance(v, dict):
        ks = sorted(v.keys(), key=lambda k: str(k))
        return '{' + ','.join(_oj.dumps(str(k), ensure_ascii=False) + ':' + _ocanon(v[k]) for k in ks) + '}'
    return _oj.dumps(str(v), ensure_ascii=False)

def _osnake(name):
    return _ore.sub(r'(?<!^)(?=[A-Z])', '_', name).lower()

def _omethod(inst, name):
    # Python people write snake_case however the spec is written, and being
    # right in the wrong casing is not a wrong answer.
    for candidate in (name, _osnake(name)):
        if hasattr(inst, candidate):
            return getattr(inst, candidate)
    raise AttributeError('${entity.name} has no method ' + name)

_otests = _oj.loads(_ob.b64decode('${payload}').decode('utf-8'))
_oresults = []
for _ot in _otests:
    _oentry = {'name': _ot['name'], 'passed': True}
    try:
        _oinst = None
        for _os in _ot['steps']:
            if _os['op'] == 'new':
                _ocls = globals().get('${entity.name}')
                if _ocls is None:
                    raise NameError('class ${entity.name} is not defined')
                _oinst = _ocls(*_os.get('args', []))
                continue
            if _os.get('throws'):
                try:
                    _omethod(_oinst, _os['op'])(*_os.get('args', []))
                except Exception:
                    continue
                _oentry.update({'passed': False, 'step': _os['op'], 'expected': 'an error', 'actual': 'no error'})
                break
            _oactual = _omethod(_oinst, _os['op'])(*_os.get('args', []))
            if 'expect' in _os:
                _ogot = _ocanon(_oactual)
                if _ogot != _os['expect']:
                    _oentry.update({'passed': False, 'step': _os['op'], 'expected': _os['expect'], 'actual': _ogot})
                    break
    except Exception as _oe:
        _oentry.update({'passed': False, 'error': type(_oe).__name__ + ': ' + str(_oe)[:300]})
    _oresults.append(_oentry)

print('${marker}' + _oj.dumps(_oresults))
`;
