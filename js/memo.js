// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Hank Wang

// 備忘錄資料層：筆記 CRUD + 留言 + Realtime。鏡像 packing.js。
// 弱連結：只認 trip_id / memo_id / member_id，不引用其他功能模組。
import { supabase, subscribeChannel } from "@/supabase.js";

// 置頂的排前面，其餘新的在上（討論事項通常看最新那幾則）
export async function listMemos(tripId) {
  const { data, error } = await supabase
    .from("memos").select("*").eq("trip_id", tripId)
    .order("pinned", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

export async function addMemo(tripId, memo, createdBy) {
  const { data, error } = await supabase.from("memos").insert({
    trip_id: tripId,
    created_by: createdBy || null,
    title: memo.title || null,
    body: memo.body || "",
    pinned: memo.pinned ?? false,
  }).select().single();
  if (error) throw error;
  return data;
}

export async function updateMemo(id, patch) {
  const { error } = await supabase
    .from("memos").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw error;
}

export async function deleteMemo(id) {
  const { error } = await supabase.from("memos").delete().eq("id", id);
  if (error) throw error;
}

// 整趟的留言一次撈回來，前端再依 memo_id 分組：筆記數量本來就少，
// 每則各發一次請求只是把同樣的資料拆成 N 個 round trip。
export async function listComments(tripId) {
  const { data, error } = await supabase
    .from("memo_comments").select("*").eq("trip_id", tripId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data;
}

export async function addComment(tripId, memoId, memberId, body) {
  const { data, error } = await supabase.from("memo_comments").insert({
    trip_id: tripId, memo_id: memoId, member_id: memberId, body,
  }).select().single();
  if (error) throw error;
  return data;
}

export async function deleteComment(id) {
  const { error } = await supabase.from("memo_comments").delete().eq("id", id);
  if (error) throw error;
}

export function subscribeMemo(tripId, onChange) {
  return subscribeChannel("memo-" + tripId, [
    { event: "*", schema: "public", table: "memos", filter: `trip_id=eq.${tripId}` },
    { event: "*", schema: "public", table: "memo_comments", filter: `trip_id=eq.${tripId}` },
  ], onChange);
}
