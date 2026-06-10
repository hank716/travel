// 行李清單資料層：CRUD + Realtime。鏡像 itinerary.js。
// 弱連結：只認 trip_id / member_id（null = 共用），不引用行程或天氣模組。
import { supabase } from "./supabase.js";

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

export function subscribePacking(tripId, onChange) {
  const channel = supabase
    .channel("packing-" + tripId)
    .on("postgres_changes",
      { event: "*", schema: "public", table: "packing_items", filter: `trip_id=eq.${tripId}` },
      onChange)
    .subscribe();
  return () => supabase.removeChannel(channel);
}
