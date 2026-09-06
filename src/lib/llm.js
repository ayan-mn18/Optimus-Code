import { env } from '../config/env.js';

/**
 * One OpenAI-compatible client for the whole app.
 *
 * Muse Spark 1.3 Contributor is reached the same way whether it is served by
 * Meta's Model API (https://api.meta.ai/v1) or by a gateway — both speak
 * /chat/completions, so only LLM_BASE_URL and LLM_API_KEY change between them.
 */

export class LlmError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const llmConfigured = () => Boolean(env.ai.apiKey);

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
  schemaName = 'result',
  tools,
  messages,
  effort = 'medium',
  maxTokens = 8000,
  model = env.ai.model,
  fetchImpl = fetch,
}) {
  if (!llmConfigured()) throw new LlmError(503, 'No LLM_API_KEY configured');

  const body = {
    model,
    max_tokens: maxTokens,
    messages: messages ?? [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user },
    ],
    // Muse Spark exposes reasoning effort; providers that do not understand the
    // field ignore it rather than failing.
    reasoning: { effort },
  };

  if (schema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: schemaName, strict: true, schema },
    };
  }
  if (tools) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const response = await fetchImpl(`${env.ai.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.ai.apiKey}`,
      'content-type': 'application/json',
      ...(env.ai.workspaceId ? { 'x-workspace-id': env.ai.workspaceId } : {}),
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new LlmError(response.status, payload?.error?.message ?? `LLM request failed (${response.status})`);
  }

  const choice = payload.choices?.[0];
  return {
    message: choice?.message ?? {},
    text: choice?.message?.content ?? '',
    toolCalls: choice?.message?.tool_calls ?? [],
    finishReason: choice?.finish_reason,
    usage: payload.usage ?? {},
  };
}

/** Structured call that returns parsed JSON, or throws if the model ignored the schema. */
export async function chatJson(options) {
  const result = await chat(options);
  try {
    return JSON.parse(result.text);
  } catch {
    // Some providers wrap JSON in a fence even under a schema.
    const fenced = result.text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) return JSON.parse(fenced[1]);
    throw new LlmError(502, 'Model did not return parseable JSON');
  }
}
