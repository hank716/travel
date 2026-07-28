// 跨模組共用的小工具：跳脫、toast、錯誤訊息翻譯。
// 抽出來的原因：對話式 AI 外殼（aichat.js）也要用同一套，
// 不想為了兩三個函式讓它反過來相依 app.js（會變成循環引用）。

const $ = (s) => document.querySelector(s);

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
export function escapeAttr(s) { return escapeHtml(s); }

// 底部短暫提示（取代成功/失敗 alert）
// action = { label, run } 時附一顆按鈕（例：刪除後的「復原」），並把逾時拉長讓人來得及按
let toastTimer = null;
export function toast(msg, ok = true, action = null) {
  const el = $("#toast");
  el.textContent = msg;                 // 純文字，不碰 innerHTML
  el.dataset.ok = ok ? "true" : "false";
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "toast-act";
    b.textContent = action.label;
    b.onclick = () => { clearTimeout(toastTimer); el.hidden = true; action.run(); };
    el.appendChild(b);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), action ? 5000 : 2600);
}

// Enter 一律不送出 —— 打字打到一半按 Enter 就存檔太容易誤觸（尤其手機）。
// 送出改走各表單本來就有的按鈕；textarea 的 Enter 恢復成單純換行。
//
// 用 document 層的 capture 監聽而不是逐一改表單，理由有二：
//   1. 備忘錄的留言表單是每次 render 動態產生的，逐一綁會漏
//   2. 大多數表單根本沒有 keydown handler，Enter 送出是瀏覽器的 implicit
//      submission，只有在 submit 事件發生前攔下按鍵才擋得掉
export function blockEnterSubmit() {
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    // 中日韓輸入法組字中的 Enter 是「確認選字」，攔下來中文就打不出來了。
    // 這一行必須在所有判斷的最前面。（229 是舊瀏覽器沒有 isComposing 時的退路）
    if (e.isComposing || e.keyCode === 229) return;

    const t = e.target;
    if (!t || !t.tagName) return;
    const tag = t.tagName.toLowerCase();
    // textarea 換行、按鈕/連結/選單要保留鍵盤操作（無障礙）
    if (tag !== "input") return;
    const type = (t.type || "text").toLowerCase();
    if (["submit", "button", "reset", "checkbox", "radio", "image", "file"].includes(type)) return;
    // 逃生門：登入這種「Enter 送出」已是肌肉記憶的表單留原本行為
    if (t.closest("form[data-enter-submit]")) return;

    e.preventDefault();
  }, true);
}

export function humanError(err) {
  const m = err?.message || String(err);
  if (/code taken/i.test(m)) return "這個行程碼已被使用，換一個吧。";
  if (/invalid code/i.test(m)) return "行程碼只能用英文或數字，長度 3–12 碼。";
  if (/name required/i.test(m)) return "請輸入你的名字。";
  if (/not found/i.test(m)) return "找不到這個行程碼，請確認後再試。";
  if (/not authenticated/i.test(m)) return "身份尚未就緒，請重新整理頁面。";
  if (/RESOURCE_EXHAUSTED|\b429\b/.test(m)) return "AI 今天的免費額度用完了，請稍後再試。";
  if (/不是合法 JSON|全部模型失敗/.test(m)) return "AI 服務異常：" + m;
  // 以下三種來自 Edge Function（ai-assist），原文是給開發者看的，直接吐出來使用者看不懂
  if (/尚未設定 GEMINI_API_KEY/.test(m)) return "AI 功能還沒啟用 —— 請管理員設定 Gemini 金鑰。";
  if (/^未登入$/.test(m)) return "登入逾時，請重新整理頁面。";
  if (/^僅限管理員$/.test(m)) return "這個功能只有管理員能用。";
  return m;
}
