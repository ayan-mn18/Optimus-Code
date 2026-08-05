import dotenv from 'dotenv';

dotenv.config();

function required(key) {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}. Copy .env.example to .env and fill it in.`);
  }
  return value;
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
};
