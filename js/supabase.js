// Supabase client 初始化 + 隱形匿名登入。
// 透過 CDN ESM 載入 supabase-js（零建置，可直接上 GitHub Pages）。
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.APP_CONFIG;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storageKey: "jp-trip-auth", // 每個瀏覽器一個穩定身份
  },
});

// 確保有匿名身份（auth.uid），RLS 才能綁定成員。回傳 user。
export async function ensureAuth() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.user) return session.user;
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  return data.user;
}
