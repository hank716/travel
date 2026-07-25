// 行程項目資料層：CRUD + Realtime。
import { supabase } from "@/supabase.js";

// 一律照「時間前後」排：日期 → 開始時間 → 結束時間 → sort_order → 建立時間。
//
// 沒填時間的要排在當天「最後」（nullsFirst: false）。以前是 nulls first，
// 沒時間的會插到當天最前面，而它們的 sort_order 又常常都是 0（AI 新增的預設值），
// 於是退回資料列的實體順序 —— 看起來就變成「照建立時間排」。
// 最後補 created_at 當定序，同分時順序才不會每次查詢都飄。
export async function listItems(tripId) {
  const { data, error } = await supabase
    .from("itinerary_items").select("*").eq("trip_id", tripId)
    .order("day_date", { ascending: true, nullsFirst: false })
    .order("start_time", { ascending: true, nullsFirst: false })
    .order("end_time", { ascending: true, nullsFirst: false })
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data;
}

export async function addItem(tripId, item, createdBy) {
  const { data, error } = await supabase.from("itinerary_items").insert({
    trip_id: tripId,
    created_by: createdBy || null,
    day_date: item.day_date || null,
    start_time: item.start_time || null,
    end_time: item.end_time || null,
    title: item.title,
    category: item.category || null,
    location_name: item.location_name || null,
    map_query: item.map_query || item.location_name || item.title || null,
    notes: item.notes || null,
    sort_order: item.sort_order ?? 0,
  }).select().single();
  if (error) throw error;
  return data;
}

export async function updateItem(id, patch) {
  const { error } = await supabase.from("itinerary_items").update(patch).eq("id", id);
  if (error) throw error;
}

export async function deleteItem(id) {
  const { error } = await supabase.from("itinerary_items").delete().eq("id", id);
  if (error) throw error;
}

// 批次清空。day: 'YYYY-MM-DD' = 只清那天；'' = 只清未排定日期；null = 全部清光。
// 清單那邊用 (day_date || "") 當分組 key，所以空字串要對應 is null，不能用 eq。
export async function clearItems(tripId, day = null) {
  let q = supabase.from("itinerary_items").delete().eq("trip_id", tripId);
  if (day === "") q = q.is("day_date", null);
  else if (day) q = q.eq("day_date", day);
  const { error } = await q;
  if (error) throw error;
}

export function subscribeItinerary(tripId, onChange) {
  const channel = supabase
    .channel("itin-" + tripId)
    .on("postgres_changes",
      { event: "*", schema: "public", table: "itinerary_items", filter: `trip_id=eq.${tripId}` },
      onChange)
    .subscribe();
  return () => supabase.removeChannel(channel);
}
