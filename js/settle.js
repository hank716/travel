// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Hank Wang

// 結算演算法（純函式）：把多幣別支出換算到基準幣別後算出每人餘額與最少轉帳。

const EPS = 0.005;

// 每人餘額（基準幣別）：paid 付出、owed 應攤、net = paid - owed
export function computeBalances(expenses, members, base) {
  const acc = new Map(members.map((m) => [m.id, { paid: 0, owed: 0 }]));
  for (const e of expenses) {
    const rate = Number(e.rate_to_base) || 1;
    if (e.paid_by && acc.has(e.paid_by)) acc.get(e.paid_by).paid += Number(e.amount) * rate;
    for (const s of e.expense_splits || []) {
      if (acc.has(s.member_id)) acc.get(s.member_id).owed += Number(s.share_amount) * rate;
    }
  }
  return members.map((m) => {
    const b = acc.get(m.id);
    return { member: m, paid: b.paid, owed: b.owed, net: b.paid - b.owed };
  });
}

// 各幣別原幣總額 + 換算基準幣總額
export function currencyTotals(expenses) {
  const byCur = new Map();
  let base = 0;
  for (const e of expenses) {
    byCur.set(e.currency, (byCur.get(e.currency) || 0) + Number(e.amount));
    base += Number(e.amount) * (Number(e.rate_to_base) || 1);
  }
  return { byCurrency: byCur, base };
}

// 最少轉帳：把欠款者依序付給債權者（貪婪法）
export function settleUp(balances) {
  const creditors = balances.filter((b) => b.net > EPS)
    .map((b) => ({ member: b.member, amt: b.net })).sort((a, b) => b.amt - a.amt);
  const debtors = balances.filter((b) => b.net < -EPS)
    .map((b) => ({ member: b.member, amt: -b.net })).sort((a, b) => b.amt - a.amt);

  const tx = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amt, creditors[j].amt);
    tx.push({ from: debtors[i].member, to: creditors[j].member, amount: pay });
    debtors[i].amt -= pay; creditors[j].amt -= pay;
    if (debtors[i].amt < EPS) i++;
    if (creditors[j].amt < EPS) j++;
  }
  return tx;
}

// 均分：把金額平均分給選定成員，最後一人吸收四捨五入餘數，確保總和相等
export function splitEqually(amount, memberIds, zeroDecimal = false) {
  const n = memberIds.length;
  if (!n) return [];
  const factor = zeroDecimal ? 1 : 100;
  const each = Math.round((amount / n) * factor) / factor;
  return memberIds.map((id, idx) => ({
    member_id: id,
    share_amount: idx < n - 1 ? each : Math.round((amount - each * (n - 1)) * factor) / factor,
  }));
}
