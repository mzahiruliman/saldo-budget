import { createHandler } from './handler.mjs';

// Only project-public credentials: capability validation happens inside the RPC.
let publishable;
try {
  const keys = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}');
  if (keys && typeof keys === 'object') {
    publishable = typeof keys.default === 'string' && keys.default.trim()
      ? keys.default
      : Object.values(keys).find((value) => typeof value === 'string' && value.trim());
  }
} catch { /* Legacy public/local fallback; never read a privileged environment key. */ }
const key = publishable || Deno.env.get('SUPABASE_PUBLISHABLE_KEY') || Deno.env.get('SB_PUBLISHABLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY');
Deno.serve(createHandler({ url: Deno.env.get('SUPABASE_URL'), key }));
