// 共用的對話式 AI 外殼：行程、記帳、行李三個功能共用同一個視窗與同一套安全機制。
//
// 對話式 AI 麻煩的不是叫模型，而是「別把資料改壞」。這裡收斂的就是那幾件事：
//   1. 只把短代號 #n 交給模型，UUID 留在前端 —— 模型會幻覺代號，指錯就對照不到，那條直接丟掉
//   2. 每輪重抓快照 —— 多人即時同步下，畫面上的資料可能已經過期
//   3. session guard —— 關掉視窗後才回來的回應要丟掉，不能貼進下一場對話
//   4. 變更先列成勾選清單，使用者按了「套用」才寫進資料庫
//   5. 套用依「刪除 → 修改 → 新增」排序，單筆失敗不中斷其餘，套完鎖卡防重按
//
// 各功能只要提供 adapter（見 cfg），不必再抄一次這些機制。

import { callAI } from "@/ai.js";
import { escapeHtml, toast, humanError } from "@/ui.js";

const $ = (s) => document.querySelector(s);

// 對話只活在視窗開著的期間，關掉就清空（不進資料庫，也不佔 Supabase 額度）
let chat = null;

/**
 * cfg（adapter）需要提供：
 *   title        視窗標題
 *   hint         底部說明（可省略）
 *   placeholder  輸入框提示（可省略）
 *   mode         Edge Function 的 mode 字串
 *   guard()      有沒有編輯權限；回 false 就不開
 *   scope        null＝不顯示範圍下拉；否則 { options(), initial() }
 *   greeting(scope)          招呼語 HTML（自行 escape）
 *   load(scope)              async → ctx（至少含 refMap；其餘自由，會原樣傳給後面幾個 hook）
 *   payload(ctx, scope)      要送給 AI 的欄位（mode / history / message 由外殼補）
 *   validate(rawOps, ctx, scope)  前端最後一道防線 → 正規化後的 ops 陣列
 *   describe(op)             預覽列的 { kind, html }（html 自行 escape）
 *   apply(op)                async，實際寫入單筆
 *   after()                  async，套用完的重繪
 */
export function openAiChat(cfg) {
  if (cfg.guard && !cfg.guard()) return;
  chat = { cfg, history: [], busy: false };

  $("#aiChatTitle").textContent = cfg.title || "✨ AI 助手";
  $("#aiChatHint").textContent = cfg.hint || "AI 提出的變更會先列成清單，你確認後才會寫入。";
  $("#aiChatInput").value = "";
  $("#aiChatInput").placeholder = cfg.placeholder || "說說你想怎麼改…（Enter 送出、Shift+Enter 換行）";
  $("#aiChatSend").disabled = false;

  const sel = $("#aiChatScope");
  if (cfg.scope) {
    const opts = cfg.scope.options() || [];
    sel.innerHTML = opts.map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join("");
    const want = cfg.scope.initial ? cfg.scope.initial() : "";
    sel.value = opts.some((o) => o.value === want) ? want : (opts[0]?.value ?? "");
    sel.hidden = false;
  } else {
    sel.innerHTML = "";
    sel.hidden = true;
  }

  $("#aiChatLog").innerHTML = cfg.greeting ? cfg.greeting(currentScope()) : "";
  $("#aiChatModal").hidden = false;
  // 手機上自動 focus 會直接彈鍵盤把對話擠掉，只在桌機做
  if (window.innerWidth > 520) $("#aiChatInput").focus();
}

export function closeAiChat() {
  $("#aiChatModal").hidden = true;
  $("#aiChatLog").innerHTML = "";
  chat = null;
}

export function currentScope() {
  const sel = $("#aiChatScope");
  return chat?.cfg?.scope ? sel.value : "";
}

// 對話一開始就不要再動招呼語，免得把使用者講過的話洗掉
export function chatUntouched() {
  return !$("#aiChatLog").querySelector(".ai-msg--user, .ai-ops");
}

// 換範圍就換招呼語：能動的範圍變了，示範也要跟著變
export function refreshGreeting() {
  if (chat?.cfg?.greeting && chatUntouched()) {
    $("#aiChatLog").innerHTML = chat.cfg.greeting(currentScope());
  }
}

// 對話泡泡。一律 textContent，不碰 innerHTML。
function push(role, text, ok = true) {
  const log = $("#aiChatLog");
  const el = document.createElement("div");
  el.className = `ai-msg ai-msg--${role === "user" ? "user" : "ai"}`;
  if (!ok) el.dataset.ok = "false";
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

export async function sendAiChat() {
  if (!chat || chat.busy) return;
  const cfg = chat.cfg;
  if (cfg.guard && !cfg.guard()) return;
  const input = $("#aiChatInput");
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  push("user", message);

  chat.busy = true;
  const sendBtn = $("#aiChatSend");
  sendBtn.disabled = true;
  const bubble = push("ai", "思考中…");
  // 開關視窗會換掉整個 chat 物件。抓著這一輪的參照，回應太慢時才不會把
  // 上一場對話的結果貼進新的對話裡。
  const session = chat;
  try {
    const scope = currentScope();
    const ctx = await cfg.load(scope);     // 每輪重抓最新快照
    const { reply, ops: raw } = await callAI(cfg.mode, {
      ...cfg.payload(ctx, scope),
      history: session.history.slice(-6),  // 只帶文字，讓「再早一點」這種指代接得上
      message,
    });

    if (chat !== session) return;          // 這場對話已經被關掉了，結果直接丟棄
    const ops = cfg.validate(raw, ctx, scope);
    bubble.textContent = reply
      || (ops.length ? "我調整了以下項目：" : "我不太確定你想怎麼改，可以再說得具體一點嗎？");
    if (ops.length) renderOpsCard(ops, cfg, session);
    session.history.push({ role: "user", text: message }, { role: "ai", text: reply || "" });
  } catch (e) {
    if (chat !== session) return;
    bubble.textContent = humanError(e);
    bubble.dataset.ok = "false";
  } finally {
    session.busy = false;
    if (chat === session) {
      sendBtn.disabled = false;
      $("#aiChatLog").scrollTop = $("#aiChatLog").scrollHeight;
    }
  }
}

// 變更預覽卡：每列一條變更，預設全勾，按了「套用」才真的寫進資料庫。
function renderOpsCard(ops, cfg, session) {
  const log = $("#aiChatLog");
  const card = document.createElement("div");
  card.className = "ai-ops";
  card.innerHTML = ops.map((o, idx) => {
    const d = cfg.describe(o);
    return `<label class="ai-op" data-kind="${d.kind}">
        <input type="checkbox" data-op="${idx}" checked />
        <span class="ai-op-txt">${d.html}</span>
      </label>`;
  }).join("") +
    `<div class="ai-ops-foot"><button class="btn btn--sm" type="button" data-apply></button></div>`;
  log.appendChild(card);

  const applyBtn = card.querySelector("[data-apply]");
  const boxes = [...card.querySelectorAll("[data-op]")];
  const sync = () => {
    const n = boxes.filter((b) => b.checked).length;
    applyBtn.textContent = n ? `套用勾選的 ${n} 項` : "沒有勾選任何變更";
    applyBtn.disabled = !n;
  };
  boxes.forEach((b) => (b.onchange = sync));
  sync();
  applyBtn.onclick = () => applyOps(ops, boxes.map((b) => b.checked), card, applyBtn, cfg, session);
  log.scrollTop = log.scrollHeight;
}

const OP_VERB = { delete: "刪除", update: "修改", create: "新增" };
const opLabel = (cfg, o) => `${OP_VERB[o.op] || o.op}「${cfg.label ? cfg.label(o) : ""}」`;

// 依 刪除 → 修改 → 新增 的順序套用；單筆失敗不中斷其餘。
async function applyOps(all, checked, card, btn, cfg, session) {
  const ops = all.filter((_, i) => checked[i]);
  if (!ops.length) return;
  if (cfg.guard && !cfg.guard()) return;
  btn.disabled = true;
  btn.textContent = "套用中…";
  const order = { delete: 0, update: 1, create: 2 };
  const done = [];
  let ok = 0, fail = 0;
  for (const o of [...ops].sort((a, b) => order[a.op] - order[b.op])) {
    try { await cfg.apply(o); ok++; done.push(o); } catch { fail++; }
  }
  // 套用過就鎖住整張卡，避免同一份變更被按第二次
  card.dataset.done = "true";
  card.querySelectorAll("input, button").forEach((el) => (el.disabled = true));
  btn.textContent = fail ? `已套用 ${ok} 項（${fail} 項失敗）` : `已套用 ${ok} 項`;
  await Promise.resolve(cfg.after?.()).catch(() => {});
  toast(fail ? `已套用 ${ok} 項，${fail} 項失敗` : `已套用 ${ok} 項變更`, !fail);

  // 把「實際發生了什麼」寫回對話歷史。少了這段，模型會以為自己上一輪宣稱的異動
  // 全都成立（使用者其實可以取消勾選），下一輪就會說出「那筆已經刪掉了」這種錯話。
  if (session && cfg.label) {
    const skipped = all.filter((o) => !done.includes(o));
    const parts = [];
    if (done.length) parts.push(`實際套用了：${done.map((o) => opLabel(cfg, o)).join("、")}`);
    if (skipped.length) parts.push(`使用者沒有採用：${skipped.map((o) => opLabel(cfg, o)).join("、")}`);
    session.history.push({ role: "ai", text: `（系統紀錄）${parts.join("；")}。` });
  }
}

// 綁一次就好：三個功能共用同一組 DOM
export function bindAiChat() {
  $("#aiChatClose").onclick = closeAiChat;
  $("#aiChatSend").onclick = sendAiChat;
  $("#aiChatScope").onchange = refreshGreeting;
  // Enter 送出、Shift+Enter 換行
  $("#aiChatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendAiChat(); }
  });
  $("#aiChatModal").addEventListener("click", (e) => { if (e.target.id === "aiChatModal") closeAiChat(); });
}
