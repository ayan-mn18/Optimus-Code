import { env } from '../config/env.js';

/**
 * One LLM client for the whole app.
 *
 * Muse Spark 1.3 Contributor is reached the same way whether it is served by
 * Meta's Model API (https://api.meta.ai/v1) or by a gateway — both speak
 * /chat/completions, so only LLM_BASE_URL and LLM_API_KEY change between them.
 *
 * Anthropic's Messages API is the one shape that is not /chat/completions, and
 * we support it here rather than in each caller: structured output arrives as a
 * forced tool call instead of a response_format, and the whole difference is
 * contained in `anthropicBody` and `readAnthropic` below. Switching providers
 * stays an environment change.
 */

export class LlmError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Strict structured output demands that `required` name EVERY key in
 * `properties` — omitting one is a 400, not a looser contract. So an optional
 * field has to be expressed as a nullable type instead. This walks a schema and
 * makes that true, so callers can write schemas the way they think about them.
 */
/**
 * Strips lone surrogates from text bound for the API.
 *
 * Scraped pages occasionally carry an unpaired surrogate — half of an emoji cut
 * by a truncation, usually. `JSON.stringify` faithfully emits it as `\ud800`,
 * which JavaScript's own parser accepts but a strict server-side parser rejects
 * with "unexpected end of hex escape". The whole request 400s and the article is
 * lost over one invisible character.
 */
export function sanitiseForJson(text) {
  if (typeof text !== 'string') return text;
  // A high surrogate not followed by a low one, or a low one not preceded by a high one.
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

export function strictify(node) {
  if (Array.isArray(node)) return node.map(strictify);
  if (!node || typeof node !== 'object') return node;

  const out = { ...node };
  // A caller that explicitly wants an open object means it — strict mode simply
  // cannot express that, which is why such schemas go through json_object mode.
  if (out.additionalProperties === true) return out;
  if (out.properties && typeof out.properties === 'object') {
    const keys = Object.keys(out.properties);
    const required = new Set(out.required ?? keys);

    out.properties = Object.fromEntries(
      keys.map((key) => {
        const child = strictify(out.properties[key]);
        // Anything the caller left out of `required` becomes explicitly nullable.
        if (!required.has(key) && typeof child.type === 'string') {
          return [key, { ...child, type: [child.type, 'null'] }];
        }
        return [key, child];
      }),
    );
    out.required = keys;
    out.additionalProperties = false;
  }
  if (out.items) out.items = strictify(out.items);
  return out;
}

export const llmConfigured = () => Boolean(env.ai.apiKey);

const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 600_000);
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

/**
 * A hung request is worse than a failed one: a generation that never answers
 * blocks a batch for as long as the socket stays open. Bound it, and retry the
 * transient failures — rate limits and gateway hiccups — twice.
 *
 * The bound is generous on purpose. Writing a class, a reference implementation
 * and a ten-scenario test suite at high effort legitimately takes minutes, and a
 * tight limit throws away good work at the finish line; a shorter one here cost
 * six questions in a single warming run. What must not happen is a timeout being
 * retried, which is why that case throws instead of looping.
 */
async function post(fetchImpl, url, headers, body, timeoutMs = TIMEOUT_MS) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok) return payload;
      const message = payload?.error?.message ?? `LLM request failed (${response.status})`;
      if (!RETRYABLE.has(response.status)) throw new LlmError(response.status, message);
      lastError = new LlmError(response.status, message);
    } catch (error) {
      if (error instanceof LlmError) throw error;
      if (error?.name === 'AbortError') {
        // A request that ran out the clock will not beat it on the next go, and
        // a caller retrying above us would multiply the wait.
        throw new LlmError(504, `LLM request timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      lastError = new LlmError(502, error?.message ?? 'LLM request failed');
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => { setTimeout(resolve, 1000 * 2 ** attempt); });
  }
  throw lastError;
}

/**
 * @param {object}   options
 * @param {string}   options.system      instruction text
 * @param {string}   options.user        the prompt
 * @param {object=}  options.schema      JSON Schema — enables strict structured output
 * @param {Array=}   options.tools       OpenAI-shaped tool definitions
 * @param {Array=}   options.messages    full history, used instead of system+user
 * @param {string=}  options.effort      minimal | low | medium | high | xhigh
 */
export async function chat({
  system,
  user,
  schema,
  json = false,
  schemaName = 'result',
  tools,
  messages,
  // Some documents carry free-form JSON values that OpenAI's strict mode cannot
  // express. Anthropic's tool schemas can, so the same schema is used as a
  // forced tool there and degraded to plain JSON mode elsewhere.
  looseSchema = false,
  effort = 'medium',
  maxTokens = 8000,
  model = env.ai.model,
  timeoutMs = TIMEOUT_MS,
  fetchImpl = fetch,
}) {
  if (!llmConfigured()) throw new LlmError(503, 'No LLM_API_KEY configured');

  const { body, url, headers, isAnthropic } = buildRequest({
    system, user, schema, json, schemaName, tools, messages, looseSchema, effort, maxTokens, model,
  });

  const payload = await post(fetchImpl, url, headers, isAnthropic ? toAnthropic(body, { schema, schemaName }) : body, timeoutMs);

  if (isAnthropic) return readAnthropic(payload);

  const choice = payload.choices?.[0];
  return {
    message: choice?.message ?? {},
    text: choice?.message?.content ?? '',
    toolCalls: choice?.message?.tool_calls ?? [],
    finishReason: choice?.finish_reason,
    usage: payload.usage ?? {},
  };
}

/** The wire shape for one call, so a provider quirk is fixed in one place. */
function buildRequest({
  system, user, schema, json, schemaName, tools, messages, looseSchema, effort, maxTokens, model,
}) {
  const body = {
    model,
    max_tokens: maxTokens,
    messages: (messages ?? [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user },
    ]).map((message) => ({ ...message, content: sanitiseForJson(message.content) })),
    // OpenAI-style scalar. Meta rejects the nested `reasoning` object outright
    // ("unknown parameter `reasoning`"), so this is the portable spelling.
    reasoning_effort: effort,
  };

  if (schema && !looseSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: schemaName, strict: true, schema: strictify(schema) },
    };
  } else if (json || looseSchema) {
    // Strict schemas must close every object, so a document with free-form
    // blocks cannot be expressed as one. We validate it ourselves instead.
    body.response_format = { type: 'json_object' };
  }
  if (tools) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const isAnthropic = env.ai.provider === 'anthropic';
  return {
    body,
    isAnthropic,
    url: isAnthropic ? `${env.ai.baseUrl}/messages` : `${env.ai.baseUrl}/chat/completions`,
    headers: isAnthropic
      ? {
        'x-api-key': env.ai.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        ...(env.ai.workspaceId ? { 'anthropic-workspace-id': env.ai.workspaceId } : {}),
      }
      : {
        authorization: `Bearer ${env.ai.apiKey}`,
        'content-type': 'application/json',
        ...(env.ai.workspaceId ? { 'x-workspace-id': env.ai.workspaceId } : {}),
      },
  };
}

/**
 * Anthropic speaks messages, not chat completions: the system prompt is its own
 * field, and structured output is a tool the model is forced to call rather than
 * a response format. Reasoning effort has no portable spelling here, so it goes.
 */
function toAnthropic(body, { schema, schemaName }) {
  const system = body.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
  const messages = body.messages.filter((message) => message.role !== 'system');
  return {
    model: body.model,
    max_tokens: body.max_tokens,
    ...(system ? { system } : {}),
    messages,
    ...(schema
      ? {
        tools: [{ name: schemaName, description: `Return the ${schemaName}.`, input_schema: schema }],
        tool_choice: { type: 'tool', name: schemaName },
      }
      : {}),
    ...(body.tools && !schema ? { tools: body.tools } : {}),
  };
}

function readAnthropic(payload) {
  const parts = payload.content ?? [];
  const forced = parts.find((part) => part.type === 'tool_use');
  return {
    message: { role: 'assistant', content: parts },
    // A forced tool call IS the structured answer; hand it back as text so
    // chatJson parses it the same way it parses every other provider.
    text: forced ? JSON.stringify(forced.input) : parts.find((part) => part.type === 'text')?.text ?? '',
    toolCalls: parts.filter((part) => part.type === 'tool_use'),
    finishReason: payload.stop_reason,
    usage: payload.usage ?? {},
  };
}

/**
 * Repairs the JSON damage models actually produce.
 *
 * The one seen in practice is a truncated unicode escape — a bare `\u` or
 * `\u12` left mid-string — which makes JSON.parse throw "unexpected end of hex
 * escape" and loses an otherwise complete article. A lone trailing backslash
 * does the same. Both are safe to neutralise: they carry no meaning, and the
 * alternative is discarding the whole document.
 */
export function repairJson(text) {
  return text
    // \u not followed by four hex digits
    .replace(/\\u(?![0-9a-fA-F]{4})/g, '\\\\u')
    // a backslash that escapes nothing legal
    .replace(/\\(?!["\\/bfnrtu])/g, '\\\\')
    // Raw control characters are illegal inside a JSON string. The class is
    // written out deliberately; eslint flags control chars in regexes and this
    // is the one place they are the point.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ');
}

/** Structured call that returns parsed JSON, or throws if the model ignored the schema. */
export async function chatJson(options) {
  const result = await chat(options);

  // Some providers wrap JSON in a fence even under a schema.
  const fenced = result.text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [result.text, fenced?.[1]].filter(Boolean);

  for (const candidate of candidates) {
    for (const attempt of [candidate, repairJson(candidate)]) {
      try {
        return JSON.parse(attempt);
      } catch {
        // fall through to the repaired form, then to the next candidate
      }
    }
  }
  if (['length', 'max_tokens'].includes(result.finishReason)) {
    throw new LlmError(502, `Model output was cut off at the ${options.maxTokens ?? 8000}-token limit`);
  }
  throw new LlmError(502, 'Model did not return parseable JSON');
}
