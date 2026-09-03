import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const file = resolve(process.argv[2] ?? '.env.prod');
const region = process.env.AWS_REGION ?? 'ap-south-1';
const parameterName = process.env.OPTIMUS_ENV_PARAMETER ?? '/optimus-code/prod/env';

if (!existsSync(file)) {
  throw new Error(`Missing ${file}. Create it from the production environment first.`);
}

const content = readFileSync(file, 'utf8').trim();
if (!content) throw new Error(`${file} is empty.`);

const values = Object.fromEntries(
  content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);

const required = [
  'PORT',
  'NODE_ENV',
  'CORS_ORIGIN',
  'SIGNUP_ENABLED',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
];
const missing = required.filter((key) => !values[key]);
if (missing.length) throw new Error(`Missing production values: ${missing.join(', ')}`);
if (values.NODE_ENV !== 'production') throw new Error('NODE_ENV must be production in .env.prod.');
if (values.EMAIL_DELIVERY_ENABLED === 'true' && values.EMAIL_TRANSPORT === 'smtp') {
  const smtpMissing = ['BREVO_API_KEY', 'BREVO_SMTP_HOST', 'BREVO_SMTP_PORT', 'BREVO_SMTP_USER', 'EMAIL_FROM']
    .filter((key) => !values[key]);
  if (smtpMissing.length) throw new Error(`Missing SMTP email values: ${smtpMissing.join(', ')}`);
}

const result = spawnSync(
  'aws',
  [
    'ssm',
    'put-parameter',
    '--region',
    region,
    '--name',
    parameterName,
    '--description',
    'Optimus Code production runtime environment',
    '--type',
    'SecureString',
    '--value',
    `file://${file}`,
    '--overwrite',
    '--output',
    'json',
  ],
  { stdio: 'inherit' },
);

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

console.log(`Synced ${file} to ${parameterName} in ${region}.`);
console.log('Next CI/CD deployment applies it to EC2.');
