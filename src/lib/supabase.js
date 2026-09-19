import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';
import { PostgresClient } from './postgres.js';

/**
 * Service-role client. Bypasses RLS, so every route must authorize the caller
 * before touching user-scoped rows.
 */
export const db = env.database.driver === 'native'
  ? new PostgresClient()
  : createClient(env.supabaseUrl, env.supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

/** Throws on a PostgREST error, otherwise returns the data. */
export function unwrap({ data, error }, context) {
  if (error) {
    const err = new Error(`${context}: ${error.message}`);
    err.status = 500;
    err.code = error.code;
    throw err;
  }
  return data;
}
