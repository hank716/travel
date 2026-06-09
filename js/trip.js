// 行程資料層：建立 / 加入 / 讀取 / 成員 / 啟用幣別 / Realtime。
import { supabase } from "./supabase.js";

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

// 建立新行程（建立者自動成為第一個成員）。code 留空則自動產生。
export async function createTrip({ title, start, end, base, currencies, name, color, code }) {
  const { data, error } = await supabase.rpc("create_trip", {
    p_title: title,
    p_start: start || null,
    p_end: end || null,
    p_base: base,
    p_currencies: currencies,
    p_name: name,
    p_color: color,
    p_code: code || null,
  });
  if (error) throw error;
  return data; // trips row
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

// 以行程碼加入；已是成員則更新名字/顏色
export async function joinTrip({ code, name, color }) {
  const { data, error } = await supabase.rpc("join_trip", {
    p_code: code,
    p_name: name,
    p_color: color,
  });
  if (error) throw error;
  return data; // trips row
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
