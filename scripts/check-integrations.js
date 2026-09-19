import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const backendPath = path.join(root, '.env.local');
const frontendPath = path.join(root, '..', 'Optimus-Code-UI', '.env.local');

const load = (file) => fs.existsSync(file) ? dotenv.parse(fs.readFileSync(file)) : {};
const backend = load(backendPath);
const frontend = load(frontendPath);

const groups = {
  'Google OAuth': [
    ['GOOGLE_CLIENT_ID', backend.GOOGLE_CLIENT_ID],
    ['VITE_GOOGLE_CLIENT_ID', frontend.VITE_GOOGLE_CLIENT_ID],
  ],
  'Brevo email': [
    ['BREVO_API_KEY', backend.BREVO_API_KEY],
    ['EMAIL_FROM', backend.EMAIL_FROM],
    ['EMAIL_DELIVERY_ENABLED=true', backend.EMAIL_DELIVERY_ENABLED === 'true' ? 'true' : ''],
  ],
  'Dodo Payments': [
    ['DODO_PAYMENTS_API_KEY', backend.DODO_PAYMENTS_API_KEY],
    ['DODO_PAYMENTS_WEBHOOK_KEY', backend.DODO_PAYMENTS_WEBHOOK_KEY],
    ['DODO_MONTHLY_PRODUCT_ID', backend.DODO_MONTHLY_PRODUCT_ID],
    ['DODO_ANNUAL_PRODUCT_ID', backend.DODO_ANNUAL_PRODUCT_ID],
  ],
  'Optimus AI': [
    ['LLM_API_KEY', backend.LLM_API_KEY],
    ['LLM_BASE_URL', backend.LLM_BASE_URL],
    ['LLM_MODEL', backend.LLM_MODEL],
  ],
  'Code runner': [
    ['JUDGE0_URL', backend.JUDGE0_URL],
  ],
  'Remote database': [
    ['SUPABASE_DB_URL', backend.SUPABASE_DB_URL],
  ],
};

let ready = true;
for (const [name, entries] of Object.entries(groups)) {
  const missing = entries.filter(([, value]) => !String(value ?? '').trim()).map(([key]) => key);
  if (name === 'Google OAuth' && backend.GOOGLE_CLIENT_ID && frontend.VITE_GOOGLE_CLIENT_ID && backend.GOOGLE_CLIENT_ID !== frontend.VITE_GOOGLE_CLIENT_ID) {
    missing.push('Google client IDs must match');
  }
  if (name === 'Remote database' && String(backend.SUPABASE_DB_URL ?? '').includes('db.wtoubunooesqhxlsvcgt.supabase.co')) {
    missing.push('Use the reachable Supabase pooler URL');
  }
  const ok = missing.length === 0;
  ready &&= ok;
  console.log(`${ok ? 'READY' : 'MISSING'}  ${name}${ok ? '' : `: ${missing.join(', ')}`}`);
}

if (!ready) {
  console.error('\nFill Optimus-Code/.env.local and Optimus-Code-UI/.env.local, then run this command again.');
  process.exitCode = 1;
} else {
  console.log('\nAll provider configuration is present. Run live integration checks next.');
}
