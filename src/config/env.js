import dotenv from 'dotenv';

dotenv.config({ path: ['.env.local', '.env'] });

function required(key) {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}. Copy .env.example to .env.local and fill it in.`);
  }
  return value;
}

const brevoApiKey = process.env.BREVO_API_KEY?.trim() ?? '';
const emailFrom = process.env.EMAIL_FROM?.trim() ?? '';
const emailDeliveryEnabled = process.env.EMAIL_DELIVERY_ENABLED === 'true';
const emailTransport = (process.env.EMAIL_TRANSPORT ?? 'api').trim().toLowerCase();
const databaseUrl = process.env.DATABASE_URL?.trim() ?? '';
const databaseDriver = (process.env.DB_DRIVER ?? (databaseUrl ? 'native' : 'supabase')).trim().toLowerCase();
const nativeDatabase = databaseDriver === 'native';
const assessmentOverrideProblemIds = (process.env.ASSESSMENT_LLM_OVERRIDE_PROBLEM_IDS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const assessmentLlmOverride = {
  enabled: Boolean(assessmentOverrideProblemIds.length && process.env.ASSESSMENT_LLM_OVERRIDE_API_KEY?.trim()),
  problemIds: assessmentOverrideProblemIds,
  provider: (process.env.ASSESSMENT_LLM_OVERRIDE_PROVIDER ?? 'openai').trim().toLowerCase(),
  apiKey: process.env.ASSESSMENT_LLM_OVERRIDE_API_KEY?.trim() ?? '',
  baseUrl: (process.env.ASSESSMENT_LLM_OVERRIDE_BASE_URL ?? '').trim().replace(/\/$/, ''),
  model: process.env.ASSESSMENT_LLM_OVERRIDE_MODEL?.trim() ?? '',
  fastModel: process.env.ASSESSMENT_LLM_OVERRIDE_FAST_MODEL?.trim() ?? '',
  reasoningEffort: process.env.ASSESSMENT_LLM_OVERRIDE_REASONING_EFFORT?.trim() || 'minimal',
  openerMaxTokens: Math.max(1_200, Number(process.env.ASSESSMENT_LLM_OVERRIDE_OPENER_MAX_TOKENS ?? 2_200)),
  mcqMaxTokens: Math.max(1_200, Number(process.env.ASSESSMENT_LLM_OVERRIDE_MCQ_MAX_TOKENS ?? 3_600)),
};

export const env = {
  port: Number(process.env.PORT ?? 4000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProd: process.env.NODE_ENV === 'production',
  corsOrigins: (process.env.CORS_ORIGIN ?? 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  supabaseUrl: nativeDatabase ? (process.env.SUPABASE_URL?.trim() ?? '') : required('SUPABASE_URL'),
  supabaseServiceKey: nativeDatabase ? (process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? '') : required('SUPABASE_SERVICE_ROLE_KEY'),

  database: {
    driver: databaseDriver,
    url: databaseUrl,
    host: process.env.DATABASE_HOST?.trim() ?? '',
    port: Number(process.env.DATABASE_PORT ?? 5432),
    name: process.env.DATABASE_NAME?.trim() || 'optimus',
    user: process.env.DATABASE_USER?.trim() ?? '',
    password: process.env.DATABASE_PASSWORD ?? '',
    ssl: process.env.DATABASE_SSL !== 'false',
    poolMax: Number(process.env.DATABASE_POOL_MAX ?? 10),
    idleTimeoutMs: Number(process.env.DATABASE_IDLE_TIMEOUT_MS ?? 30_000),
    connectTimeoutMs: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS ?? 5_000),
  },

  jwt: {
    accessSecret: required('JWT_ACCESS_SECRET'),
    refreshSecret: required('JWT_REFRESH_SECRET'),
    accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
    refreshTtl: process.env.JWT_REFRESH_TTL ?? '30d',
  },

  dailyGoals: {
    DSA: Number(process.env.DAILY_DSA_TARGET ?? 3),
    LLD: Number(process.env.DAILY_LLD_TARGET ?? 1),
    HLD: Number(process.env.DAILY_HLD_TARGET ?? 1),
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID?.trim() ?? '',
  },
  ai: {
    enabled: Boolean(process.env.LLM_API_KEY?.trim()),
    provider: (process.env.LLM_PROVIDER ?? 'openai').trim().toLowerCase(),
    apiKey: process.env.LLM_API_KEY?.trim() ?? '',
    workspaceId: process.env.LLM_WORKSPACE_ID?.trim() ?? '',
    baseUrl: (process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, ''),
    model: process.env.LLM_MODEL ?? 'gpt-4o-mini',
    // Multiple choice is a short structured answer; a coding spec is not. Point
    // this at a faster model to cut the latency a student actually waits on,
    // while coding generation keeps the stronger one. Defaults to the same
    // model, so setting nothing changes nothing.
    fastModel: process.env.LLM_FAST_MODEL?.trim() || (process.env.LLM_MODEL ?? 'gpt-4o-mini'),
  },
  research: {
    // Firecrawl does both search and scrape, so there is no separate search vendor.
    firecrawlKey: process.env.FIRECRAWL_API_KEY?.trim() ?? '',
    firecrawlUrl: (process.env.FIRECRAWL_URL ?? 'https://api.firecrawl.dev/v2').replace(/\/$/, ''),
    // Rung 3: only reached when Firecrawl refuses a host outright (it blocks Reddit).
    browserUseKey: process.env.BROWSER_USE_API_KEY?.trim() ?? '',
    browserUseUrl: (process.env.BROWSER_USE_URL ?? 'https://api.browser-use.com/api/v2').replace(/\/$/, ''),
    enabled: Boolean(process.env.FIRECRAWL_API_KEY?.trim()),
    maxSearches: Number(process.env.RESEARCH_MAX_SEARCHES ?? 8),
    maxFetches: Number(process.env.RESEARCH_MAX_FETCHES ?? 10),
    concurrency: Number(process.env.RESEARCH_CONCURRENCY ?? 3),
    // Pages are network-bound; extraction waits on a reasoning model. Both are
    // independent per item, so both run several at a time.
    fetchConcurrency: Number(process.env.RESEARCH_FETCH_CONCURRENCY ?? 4),
    llmConcurrency: Number(process.env.RESEARCH_LLM_CONCURRENCY ?? 4),
    // A run that finds nothing must still cost a bounded amount.
    timeoutMs: Number(process.env.RESEARCH_TIMEOUT_MIN ?? 8) * 60_000,
    autoPublish: process.env.RESEARCH_AUTO_PUBLISH === 'true',
  },

  assessment: {
    // The worker no longer pre-seeds a bank. It exists for crash recovery:
    // finishing papers whose generation or grading was cut short.
    workerIntervalMs: Number(process.env.ASSESSMENT_WORKER_INTERVAL_MIN ?? 2) * 60_000,
    // How many ready questions the click path may draw before it answers. The
    // rest of the paper is generated behind the student.
    drawLimit: Math.max(1, Number(process.env.ASSESSMENT_DRAW_LIMIT ?? 3)),
    // Background slots are independent, so they are issued together rather than
    // queued. Coding generation is the expensive one and gets the tighter cap.
    generationConcurrency: Math.max(1, Number(process.env.ASSESSMENT_GENERATION_CONCURRENCY ?? 6)),
    codingConcurrency: Math.max(1, Number(process.env.ASSESSMENT_CODING_CONCURRENCY ?? 4)),
    // A brand-new problem has nothing to draw, so one stripped-down question is
    // generated on the request. It must never become the slow path it replaced.
    openerTimeoutMs: Number(process.env.ASSESSMENT_OPENER_TIMEOUT_MS ?? 20_000),
    mcqMaxTokens: Math.max(800, Number(process.env.ASSESSMENT_MCQ_MAX_TOKENS ?? 3_000)),
    mcqEffort: process.env.ASSESSMENT_MCQ_REASONING_EFFORT ?? 'minimal',
    // A coding spec is a statement, a class contract and a working reference;
    // the suite that follows is six to thirty scenarios of steps and expected
    // values, and is the longer of the two by some margin. At 10k the suite was
    // being cut off mid-scenario and the whole question thrown away.
    codingSpecMaxTokens: Number(process.env.ASSESSMENT_CODING_SPEC_MAX_TOKENS ?? 12_000),
    codingTestsMaxTokens: Number(process.env.ASSESSMENT_CODING_TESTS_MAX_TOKENS ?? 20_000),
    // Optional, problem-scoped LLM experiment. Disabled without IDs + key.
    llmOverride: assessmentLlmOverride,
  },

  runner: {
    // The public Judge0 instance needs no key, so coding assessments work out of
    // the box. Moving to Sulu, RapidAPI or our own box is a URL and a key.
    enabled: process.env.CODE_RUNNER_ENABLED !== 'false',
    baseUrl: (process.env.JUDGE0_URL ?? 'https://ce.judge0.com').replace(/\/$/, ''),
    apiKey: process.env.JUDGE0_API_KEY?.trim() ?? '',
    // RapidAPI and Sulu read the key from x-rapidapi-key; a self-hosted Judge0
    // reads it from X-Auth-Token.
    authHeader: (process.env.JUDGE0_AUTH_HEADER ?? 'x-rapidapi-key').trim().toLowerCase(),
    apiHost: process.env.JUDGE0_API_HOST?.trim() ?? '',
    // Deliberately modest: we are a guest on a shared judge.
    concurrency: Number(process.env.JUDGE0_CONCURRENCY ?? 4),
    timeoutMs: Number(process.env.JUDGE0_TIMEOUT_MS ?? 30_000),
    cpuTimeLimit: Number(process.env.JUDGE0_CPU_SECONDS ?? 5),
    wallTimeLimit: Number(process.env.JUDGE0_WALL_SECONDS ?? 12),
    memoryLimit: Number(process.env.JUDGE0_MEMORY_KB ?? 256_000),
    // Verification of freshly generated questions must never crowd out students.
    bankConcurrency: Number(process.env.JUDGE0_BANK_CONCURRENCY ?? 1),
  },
  billing: {
    enabled: Boolean(process.env.DODO_PAYMENTS_API_KEY?.trim()),
    apiKey: process.env.DODO_PAYMENTS_API_KEY?.trim() ?? '',
    webhookKey: process.env.DODO_PAYMENTS_WEBHOOK_KEY?.trim() ?? '',
    environment: process.env.DODO_PAYMENTS_ENVIRONMENT === 'live_mode' ? 'live_mode' : 'test_mode',
    monthlyProductId: process.env.DODO_MONTHLY_PRODUCT_ID?.trim() ?? '',
    annualProductId: process.env.DODO_ANNUAL_PRODUCT_ID?.trim() ?? '',
  },
  email: {
    enabled: emailDeliveryEnabled && Boolean(emailFrom && (emailTransport === 'smtp'
      ? process.env.BREVO_SMTP_USER?.trim() && brevoApiKey
      : brevoApiKey)),
    transport: emailTransport,
    apiKey: brevoApiKey,
    smtpHost: process.env.BREVO_SMTP_HOST?.trim() || 'smtp-relay.brevo.com',
    smtpPort: Number(process.env.BREVO_SMTP_PORT ?? 587),
    smtpUser: process.env.BREVO_SMTP_USER?.trim() ?? '',
    smtpSecure: process.env.BREVO_SMTP_SECURE === 'true',
    from: emailFrom,
    replyTo: process.env.EMAIL_REPLY_TO?.trim() || undefined,
    appUrl: (process.env.APP_URL ?? 'http://localhost:5173').replace(/\/$/, ''),
    inviteTtlHours: Number(process.env.INVITE_TOKEN_TTL_HOURS ?? 168),
    warningHour: Number(process.env.STREAK_WARNING_HOUR ?? 22),
    workerIntervalMs: Number(process.env.EMAIL_WORKER_INTERVAL_MIN ?? 15) * 60_000,
  },
};
