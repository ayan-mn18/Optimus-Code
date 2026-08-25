import dotenv from 'dotenv';

dotenv.config({ path: ['.env.local', '.env'] });

function required(key) {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}. Copy .env.example to .env.local and fill it in.`);
  }
  return value;
}

const resendApiKey = process.env.RESEND_API_KEY?.trim() ?? '';
const emailFrom = process.env.EMAIL_FROM?.trim() ?? '';
if (Boolean(resendApiKey) !== Boolean(emailFrom)) {
  throw new Error('RESEND_API_KEY and EMAIL_FROM must be configured together.');
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProd: process.env.NODE_ENV === 'production',
  corsOrigins: (process.env.CORS_ORIGIN ?? 'http://localhost:5173')
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

  dailyTarget: Number(process.env.DAILY_TARGET ?? 5),
  email: {
    enabled: Boolean(resendApiKey && emailFrom),
    apiKey: resendApiKey,
    from: emailFrom,
    replyTo: process.env.EMAIL_REPLY_TO?.trim() || undefined,
    appUrl: (process.env.APP_URL ?? 'http://localhost:5173').replace(/\/$/, ''),
    inviteTtlHours: Number(process.env.INVITE_TOKEN_TTL_HOURS ?? 168),
    warningHour: Number(process.env.STREAK_WARNING_HOUR ?? 20),
    workerIntervalMs: Number(process.env.EMAIL_WORKER_INTERVAL_MIN ?? 15) * 60_000,
  },
};
