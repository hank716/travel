// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Hank Wang

// 行李清單資料層：CRUD + Realtime。鏡像 itinerary.js。
// 弱連結：只認 trip_id / member_id（null = 共用），不引用行程或天氣模組。
import { supabase, subscribeChannel } from "@/supabase.js";

export async function listPacking(tripId) {
  const { data, error } = await supabase
    .from("packing_items").select("*").eq("trip_id", tripId)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data;
}

export async function addPacking(tripId, item, createdBy) {
  const { data, error } = await supabase.from("packing_items").insert({
    trip_id: tripId,
    created_by: createdBy || null,
    member_id: item.member_id || null,        // null = 共用/全體
    name: item.name,
    category: item.category || null,
    qty: item.qty ?? 1,
    checked: item.checked ?? false,
    note: item.note || null,
    sort_order: item.sort_order ?? 0,
  }).select().single();
  if (error) throw error;
  return data;
}

export async function updatePacking(id, patch) {
  const { error } = await supabase.from("packing_items").update(patch).eq("id", id);
  if (error) throw error;
}

export async function deletePacking(id) {
  const { error } = await supabase.from("packing_items").delete().eq("id", id);
  if (error) throw error;
}

// 清空行李。onlyChecked=true 只清掉已打包的（收行李收到一半想把打勾的收走時用）
export async function clearPacking(tripId, onlyChecked = false) {
  let q = supabase.from("packing_items").delete().eq("trip_id", tripId);
  if (onlyChecked) q = q.eq("checked", true);
  const { error } = await q;
  if (error) throw error;
}

export function subscribePacking(tripId, onChange) {
  return subscribeChannel("packing-" + tripId, [
    { event: "*", schema: "public", table: "packing_items", filter: `trip_id=eq.${tripId}` },
  ], onChange);
}
