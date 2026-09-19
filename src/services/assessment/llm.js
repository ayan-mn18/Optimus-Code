import { env } from '../../config/env.js';
import { chatJson } from '../../lib/llm.js';

export function assessmentModel(problemId) {
  const override = env.assessment.llmOverride;
  return override.enabled && override.problemIds.includes(problemId)
    ? override.model || env.ai.model
    : env.ai.model;
}

/**
 * Return the assessment chat transport for one problem.
 *
 * The override is deliberately problem-ID scoped: a model experiment cannot
 * silently change research, blogs, or another assessment. The API key is
 * supplied through the encrypted runtime environment, never source control.
 */
export function assessmentChat(problemId) {
  const override = env.assessment.llmOverride;
  const active = override.enabled && override.problemIds.includes(problemId);
  if (!active) return chatJson;

  const config = {
    ...env.ai,
    apiKey: override.apiKey,
    baseUrl: override.baseUrl || env.ai.baseUrl,
    model: assessmentModel(problemId),
    fastModel: override.fastModel || override.model || env.ai.fastModel,
  };
  // DeepSeek implements JSON mode but currently rejects OpenAI's strict
  // `json_schema` response format. Generator schemas still validate every
  // response locally, so use the portable JSON-object envelope for this test.
  const deepSeekJsonMode = config.baseUrl.includes('deepseek.com');

  return (options = {}) => {
    const isOpener = options.maxTokens === 900;
    const isMcq = options.schemaName === 'question_set';
    const maxTokens = isOpener
      ? override.openerMaxTokens
      : isMcq
        ? override.mcqMaxTokens
        : options.maxTokens;

    return chatJson({
      ...options,
      llmConfig: config,
      model: config.model,
      effort: override.reasoningEffort,
      ...(deepSeekJsonMode ? { looseSchema: true } : {}),
      ...(maxTokens ? { maxTokens } : {}),
    });
  };
}
