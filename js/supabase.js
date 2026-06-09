// Supabase client（Email/密碼帳號制）。
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.APP_CONFIG;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storageKey: "jp-trip-auth",
  },
});
