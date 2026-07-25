// 記帳資料層：支出 + 分帳（CRUD + Realtime）。
import { supabase } from "@/supabase.js";

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

export function subscribeExpenses(tripId, onChange) {
  const channel = supabase
    .channel("exp-" + tripId)
    .on("postgres_changes",
      { event: "*", schema: "public", table: "expenses", filter: `trip_id=eq.${tripId}` },
      onChange)
    .on("postgres_changes",
      { event: "*", schema: "public", table: "expense_splits" },
      onChange)
    .subscribe();
  return () => supabase.removeChannel(channel);
}
