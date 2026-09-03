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

export const env = {
  port: Number(process.env.PORT ?? 4000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProd: process.env.NODE_ENV === 'production',
  corsOrigins: (process.env.CORS_ORIGIN ?? 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  supabaseUrl: required('SUPABASE_URL'),
  supabaseServiceKey: required('SUPABASE_SERVICE_ROLE_KEY'),

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
  },
  runner: {
    enabled: Boolean(process.env.JUDGE0_URL?.trim()),
    provider: (process.env.CODE_RUNNER_PROVIDER ?? 'judge0').trim().toLowerCase(),
    baseUrl: (process.env.JUDGE0_URL ?? '').replace(/\/$/, ''),
    apiKey: process.env.JUDGE0_API_KEY?.trim() ?? '',
    apiHost: process.env.JUDGE0_API_HOST?.trim() ?? '',
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
    warningHour: Number(process.env.STREAK_WARNING_HOUR ?? 20),
    workerIntervalMs: Number(process.env.EMAIL_WORKER_INTERVAL_MIN ?? 15) * 60_000,
  },
};
