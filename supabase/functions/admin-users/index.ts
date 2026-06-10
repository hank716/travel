// Supabase Edge Function: admin-users
// 管理員專用（用 Supabase 自動注入的 service_role）。先驗證呼叫者 profiles.is_admin。
//   supabase functions deploy admin-users --use-api
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MEMBER_DOMAIN = "guest.tripplanner.app";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

async function listUsers(admin: SupabaseClient) {
  const [{ data: profs }, usersRes, { data: members }] = await Promise.all([
    admin.from("profiles").select("id, username, is_admin"),
    admin.auth.admin.listUsers({ page: 1, perPage: 1000 }),
    admin.from("members").select("id, auth_uid, trip_id, display_name, is_admin, can_edit, trips(id, title)"),
  ]);
  const emailById = new Map((usersRes.data?.users || []).map((u) => [u.id, u.email]));
  type TripRole = { id: string; title: string; member_id: string; is_admin: boolean; can_edit: boolean };
  const tripsByUid = new Map<string, Array<TripRole>>();
  for (const m of members || []) {
    if (!m.auth_uid) continue;
    const t = (m as { trips?: { id: string; title: string } }).trips;
    if (!t) continue;
    if (!tripsByUid.has(m.auth_uid)) tripsByUid.set(m.auth_uid, []);
    tripsByUid.get(m.auth_uid)!.push({
      id: t.id, title: t.title, member_id: (m as { id: string }).id,
      is_admin: !!(m as { is_admin?: boolean }).is_admin,
      can_edit: (m as { can_edit?: boolean }).can_edit !== false,
    });
  }
  return (profs || []).map((p) => ({
    id: p.id, username: p.username, is_admin: p.is_admin,
    email: emailById.get(p.id) || "",
    trips: tripsByUid.get(p.id) || [],
  }));
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
    const callerId = ures.user.id;
    const { data: prof } = await admin.from("profiles").select("is_admin").eq("id", callerId).maybeSingle();
    if (!prof?.is_admin) return json({ error: "僅限管理員" }, 403);

    const body = await req.json().catch(() => ({}));
    const action = body.action;

    if (action === "list_users") {
      return json({ users: await listUsers(admin) });
    }

    if (action === "create_member") {
      const trip_id = body.trip_id; // 可為 null（只開帳號不指派）
      const display_name = (body.display_name || "").trim();
      const username = (body.username || "").trim().toLowerCase();
      const password = body.password || "";
      const color = body.color || "#5E7C58";
      if (!display_name || !username || !password) return json({ error: "缺少欄位（顯示名稱/帳號/密碼）" }, 400);

      const email = `${username}@${MEMBER_DOMAIN}`;
      let userId: string | null = null;
      const { data: created, error: cerr } = await admin.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { username },
      });
      if (cerr) {
        const { data: existing } = await admin.from("profiles").select("id").eq("username", username).maybeSingle();
        if (existing?.id) userId = existing.id;
        else return json({ error: "建立帳號失敗：" + cerr.message }, 400);
      } else {
        userId = created.user!.id;
        await admin.from("profiles").update({ username }).eq("id", userId);
      }
      if (trip_id) {
        const { data: dup } = await admin.from("members").select("id").eq("trip_id", trip_id).eq("auth_uid", userId).maybeSingle();
        if (!dup) {
          const { error: merr } = await admin.from("members").insert({
            trip_id, auth_uid: userId, display_name, color,
            is_admin: !!body.is_admin,
            can_edit: body.can_edit === undefined ? true : !!body.can_edit,
          });
          if (merr) return json({ error: "加入行程失敗：" + merr.message }, 400);
        }
      }
      return json({ ok: true, user_id: userId, reused: !!cerr });
    }

    if (action === "reset_password") {
      if (!body.user_id || !body.password) return json({ error: "缺少欄位" }, 400);
      const { error } = await admin.auth.admin.updateUserById(body.user_id, { password: body.password });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === "delete_user") {
      if (!body.user_id) return json({ error: "缺少 user_id" }, 400);
      if (body.user_id === callerId) return json({ error: "不能刪除自己" }, 400);
      const { data: tp } = await admin.from("profiles").select("is_admin").eq("id", body.user_id).maybeSingle();
      if (tp?.is_admin) return json({ error: "不能刪除管理員帳號" }, 400);
      await admin.from("members").delete().eq("auth_uid", body.user_id);
      const { error } = await admin.auth.admin.deleteUser(body.user_id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === "assign_trip") {
      const { user_id, trip_id } = body;
      if (!user_id || !trip_id) return json({ error: "缺少欄位" }, 400);
      const { data: dup } = await admin.from("members").select("id").eq("trip_id", trip_id).eq("auth_uid", user_id).maybeSingle();
      if (dup) return json({ ok: true, already: true });
      let display_name = (body.display_name || "").trim();
      if (!display_name) {
        const { data: p } = await admin.from("profiles").select("username").eq("id", user_id).maybeSingle();
        display_name = p?.username || "成員";
      }
      const { error } = await admin.from("members").insert({
        trip_id, auth_uid: user_id, display_name, color: "#5E7C58",
        is_admin: !!body.is_admin,
        can_edit: body.can_edit === undefined ? true : !!body.can_edit,
      });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === "unassign_trip") {
      const { user_id, trip_id } = body;
      if (!user_id || !trip_id) return json({ error: "缺少欄位" }, 400);
      const { error } = await admin.from("members").delete().eq("trip_id", trip_id).eq("auth_uid", user_id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    // 指定某成員為行程管理員（同行程其他人取消 is_admin）。可帶 member_id 或 user_id。
    if (action === "set_trip_admin") {
      const trip_id = body.trip_id;
      if (!trip_id) return json({ error: "缺少 trip_id" }, 400);
      let member_id = body.member_id;
      if (!member_id && body.user_id) {
        const { data: m } = await admin.from("members").select("id").eq("trip_id", trip_id).eq("auth_uid", body.user_id).maybeSingle();
        member_id = m?.id;
      }
      if (!member_id) return json({ error: "找不到該成員" }, 400);
      await admin.from("members").update({ is_admin: false }).eq("trip_id", trip_id);
      const { error } = await admin.from("members").update({ is_admin: true, can_edit: true }).eq("id", member_id).eq("trip_id", trip_id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    // 設定某成員為可編輯 / 唯讀。可帶 member_id 或 (trip_id + user_id)。
    if (action === "set_member_can_edit") {
      const can_edit = !!body.can_edit;
      let member_id = body.member_id;
      if (!member_id && body.trip_id && body.user_id) {
        const { data: m } = await admin.from("members").select("id").eq("trip_id", body.trip_id).eq("auth_uid", body.user_id).maybeSingle();
        member_id = m?.id;
      }
      if (!member_id) return json({ error: "找不到該成員" }, 400);
      const { error } = await admin.from("members").update({ can_edit }).eq("id", member_id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    return json({ error: "不支援的 action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
