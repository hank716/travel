// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Hank Wang

// 記帳資料層：支出 + 分帳（CRUD + Realtime）。
import { supabase, subscribeChannel } from "@/supabase.js";

// 取得支出（含分帳明細）
export async function listExpenses(tripId) {
  const { data, error } = await supabase
    .from("expenses")
    .select("*, expense_splits(*)")
    .eq("trip_id", tripId)
    .order("spent_at", { ascending: false });
  if (error) throw error;
  return data;
}

// 新增支出 + 分帳
export async function addExpense(tripId, expense, splits) {
  const { data: exp, error } = await supabase.from("expenses").insert({
    trip_id: tripId,
    paid_by: expense.paid_by || null,
    amount: expense.amount,
    currency: expense.currency,
    rate_to_base: expense.rate_to_base ?? 1,
    category: expense.category || null,
    description: expense.description || null,
    spent_at: expense.spent_at || new Date().toISOString(),
  }).select().single();
  if (error) throw error;

  await replaceSplits(exp.id, splits);
  return exp;
}

// 更新支出 + 重建分帳
export async function updateExpense(id, expense, splits) {
  const { error } = await supabase.from("expenses").update({
    paid_by: expense.paid_by || null,
    amount: expense.amount,
    currency: expense.currency,
    rate_to_base: expense.rate_to_base ?? 1,
    category: expense.category || null,
    description: expense.description || null,
    spent_at: expense.spent_at,
  }).eq("id", id);
  if (error) throw error;

  await replaceSplits(id, splits);
}

async function replaceSplits(expenseId, splits) {
  await supabase.from("expense_splits").delete().eq("expense_id", expenseId);
  if (splits && splits.length) {
    const rows = splits.map((s) => ({
      expense_id: expenseId, member_id: s.member_id, share_amount: s.share_amount,
    }));
    const { error } = await supabase.from("expense_splits").insert(rows);
    if (error) throw error;
  }
}

export async function deleteExpense(id) {
  const { error } = await supabase.from("expenses").delete().eq("id", id);
  if (error) throw error; // 分帳由 cascade 一起刪
}

// 清空整趟的支出（分帳同樣由 cascade 一起刪）
export async function clearExpenses(tripId) {
  const { error } = await supabase.from("expenses").delete().eq("trip_id", tripId);
  if (error) throw error;
}

// expense_splits 沒有 trip_id，下不了跟其他表一樣的 filter，所以會收到「所有看得到的」
// 分帳變動（RLS 之內，含別趟）而多重畫幾次。仍然要訂閱：updateExpense 是先寫 expenses
// 再 replaceSplits，只聽母表的話，對方收到 UPDATE 事件時分帳還沒換完，撈回來的是舊的
// 分攤名單，而且不會再有第二個事件來修正。多重畫幾次換不會顯示錯的分帳，划算。
export function subscribeExpenses(tripId, onChange) {
  return subscribeChannel("exp-" + tripId, [
    { event: "*", schema: "public", table: "expenses", filter: `trip_id=eq.${tripId}` },
    { event: "*", schema: "public", table: "expense_splits" },
  ], onChange);
}
