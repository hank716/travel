// 行程資料層：建立 / 加入 / 讀取 / 成員 / 啟用幣別 / Realtime。
import { supabase } from "@/supabase.js";

const LS_KEY = "jp-trip-current"; // 記住目前所在行程

export function getSavedTrip() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)); }
  catch { return null; }
}
export function saveTrip(trip) {
  localStorage.setItem(LS_KEY, JSON.stringify({ id: trip.id, code: trip.code }));
}
export function clearSavedTrip() {
  localStorage.removeItem(LS_KEY);
}

// 建立新行程。join=true（預設）→ 建立者成為第一個成員(管理員)；false → 建立者不參加。
// code 留空則自動產生。
export async function createTrip({ title, start, end, base, currencies, name, color, code, join = true }) {
  const { data, error } = await supabase.rpc("create_trip", {
    p_title: title,
    p_start: start || null,
    p_end: end || null,
    p_base: base,
    p_currencies: currencies,
    p_name: name,
    p_color: color,
    p_code: code || null,
    p_join: join,
  });
  if (error) throw error;
  return data; // trips row
}

// 管理員：建立成員帳號（使用者名稱+密碼）並加入這趟（走 Edge Function，用 service_role）
export async function provisionMember(tripId, { display_name, username, password, color }) {
  const { data, error } = await supabase.functions.invoke("admin-users", {
    body: { action: "create_member", trip_id: tripId, display_name, username, password, color },
  });
  if (error) {
    let detail = error.message || "建立失敗";
    try { const j = await error.context?.json(); if (j?.error) detail = j.error; } catch { /* ignore */ }
    throw new Error(detail);
  }
  return data;
}

// 管理員移除成員
export async function removeMember(memberId) {
  const { error } = await supabase.from("members").delete().eq("id", memberId);
  if (error) throw error;
}

// 指定某成員為行程管理員（RPC：全域 admin 或現任行程管理員皆可）
export async function setTripAdmin(tripId, memberId) {
  const { data, error } = await supabase.rpc("set_trip_admin", {
    p_trip_id: tripId, p_member_id: memberId,
  });
  if (error) throw error;
  return data;
}

// 設定某成員為可編輯 / 唯讀（RPC：全域 admin 或現任行程管理員皆可）
export async function setMemberCanEdit(memberId, canEdit) {
  const { data, error } = await supabase.rpc("set_member_can_edit", {
    p_member_id: memberId, p_can_edit: canEdit,
  });
  if (error) throw error;
  return data;
}

// 我有參與的所有行程（RLS 只會回我是成員的）
export async function listMyTrips() {
  const { data, error } = await supabase
    .from("trips").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

// 刪除整趟行程（cascade 連帶刪除成員/項目/記帳）
export async function deleteTrip(id) {
  const { error } = await supabase.from("trips").delete().eq("id", id);
  if (error) throw error;
}

// 更新行程設定（標題/日期）
export async function updateTrip(id, patch) {
  const { error } = await supabase.from("trips").update(patch).eq("id", id);
  if (error) throw error;
}

// 呼叫 admin-users Edge Function（管理員專用）
export async function adminAction(action, payload = {}) {
  const { data, error } = await supabase.functions.invoke("admin-users", {
    body: { action, ...payload },
  });
  if (error) {
    let detail = error.message || "操作失敗";
    try { const j = await error.context?.json(); if (j?.error) detail = j.error; } catch { /* ignore */ }
    throw new Error(detail);
  }
  return data;
}

export async function getTrip(id) {
  const { data, error } = await supabase.from("trips").select("*").eq("id", id).single();
  if (error) throw error;
  return data;
}

export async function listMembers(tripId) {
  const { data, error } = await supabase
    .from("members").select("*").eq("trip_id", tripId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data;
}

export async function getMyMember(tripId) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from("members").select("*")
    .eq("trip_id", tripId).eq("auth_uid", user.id).maybeSingle();
  if (error) throw error;
  return data;
}

export async function getTripCurrencies(tripId) {
  const { data, error } = await supabase
    .from("trip_currencies").select("code").eq("trip_id", tripId);
  if (error) throw error;
  return data.map((r) => r.code);
}

export async function addTripCurrency(tripId, code) {
  const { error } = await supabase
    .from("trip_currencies").insert({ trip_id: tripId, code });
  if (error) throw error;
}

export async function removeTripCurrency(tripId, code) {
  const { error } = await supabase
    .from("trip_currencies").delete().eq("trip_id", tripId).eq("code", code);
  if (error) throw error;
}

export async function updateBaseCurrency(tripId, base) {
  const { error } = await supabase
    .from("trips").update({ base_currency: base }).eq("id", tripId);
  if (error) throw error;
}

// 訂閱該行程的成員與幣別變動（即時同步），回傳取消訂閱函式
export function subscribeTrip(tripId, onChange) {
  const channel = supabase
    .channel("trip-" + tripId)
    .on("postgres_changes",
      { event: "*", schema: "public", table: "members", filter: `trip_id=eq.${tripId}` },
      onChange)
    .on("postgres_changes",
      { event: "*", schema: "public", table: "trip_currencies", filter: `trip_id=eq.${tripId}` },
      onChange)
    .subscribe();
  return () => supabase.removeChannel(channel);
}
