// Supabase Edge Function: admin-users
// 由管理員呼叫，用 service_role（Supabase 自動注入）建立成員帳號並指派行程。
// 會先驗證呼叫者是 profiles.is_admin。
//   supabase functions deploy admin-users
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MEMBER_DOMAIN = "guest.tripplanner.app";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    if (!jwt) return json({ error: "未登入" }, 401);

    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    // 驗證呼叫者為管理員
    const { data: ures, error: uerr } = await admin.auth.getUser(jwt);
    if (uerr || !ures.user) return json({ error: "未登入" }, 401);
    const { data: prof } = await admin.from("profiles").select("is_admin").eq("id", ures.user.id).maybeSingle();
    if (!prof?.is_admin) return json({ error: "僅限管理員" }, 403);

    const body = await req.json().catch(() => ({}));
    if (body.action === "create_member") {
      const trip_id = body.trip_id;
      const display_name = (body.display_name || "").trim();
      const username = (body.username || "").trim().toLowerCase();
      const password = body.password || "";
      const color = body.color || "#5E7C58";
      if (!trip_id || !display_name || !username || !password) return json({ error: "缺少欄位（行程/顯示名稱/帳號/密碼）" }, 400);

      const email = `${username}@${MEMBER_DOMAIN}`;
      let userId: string | null = null;

      const { data: created, error: cerr } = await admin.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { username },
      });
      if (cerr) {
        // 可能帳號已存在 → 找回該帳號，改為「加入這趟」
        const { data: existing } = await admin.from("profiles").select("id").eq("username", username).maybeSingle();
        if (existing?.id) userId = existing.id;
        else return json({ error: "建立帳號失敗：" + cerr.message }, 400);
      } else {
        userId = created.user!.id;
        await admin.from("profiles").update({ username }).eq("id", userId);
      }

      // 建立 membership（避免重複）
      const { data: dup } = await admin.from("members").select("id")
        .eq("trip_id", trip_id).eq("auth_uid", userId).maybeSingle();
      if (!dup) {
        const { error: merr } = await admin.from("members")
          .insert({ trip_id, auth_uid: userId, display_name, color, is_admin: false });
        if (merr) return json({ error: "加入行程失敗：" + merr.message }, 400);
      }
      return json({ ok: true, user_id: userId, reused: !!cerr });
    }

    return json({ error: "不支援的 action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
