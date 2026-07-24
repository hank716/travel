// 左滑刪除：把清單裡的每一列包一層，向左拖曳露出紅色刪除鈕。
// 三個清單（行程項目 / 記帳支出 / 行李物品）共用，純 DOM，不認識任何資料層。
const ACTION_W = 88;   // 紅鈕寬度，要和 css 的 .swipe-del 一致
const LOCK_PX = 10;    // 超過這距離才判定是橫向手勢（以下都還給瀏覽器捲動）
const OPEN_PX = 35;    // 放手時滑超過這距離就吸附成開啟

let openRow = null;    // 全域同時只允許一列打開

// 手指往左拖多少，紅鈕就從右邊推進來多少（x 是 -ACTION_W..0）。
// 刻意不去平移列本身：這幾個清單的時間/標題都靠左，整列左移 88px 會把開頭切掉，
// 看起來像壞掉。改成只讓紅鈕蓋上來，內容一個字都不會被裁到。
function setX(wrap, x) {
  wrap.querySelector(".swipe-del").style.transform = `translateX(${ACTION_W + x}px)`;
}

function close(wrap) {
  if (!wrap) return;
  wrap.classList.remove("is-dragging", "is-open");
  setX(wrap, 0);
  if (openRow === wrap) openRow = null;
}

function open(wrap) {
  if (openRow && openRow !== wrap) close(openRow);
  wrap.classList.remove("is-dragging");
  wrap.classList.add("is-open");
  setX(wrap, -ACTION_W);
  openRow = wrap;
}

// 點到別處就收回目前打開的那列（只註冊一次）
let docBound = false;
function bindDocClose() {
  if (docBound) return;
  docBound = true;
  document.addEventListener("pointerdown", (e) => {
    if (openRow && !openRow.contains(e.target)) close(openRow);
  }, true);
}

/**
 * 對清單內符合 rowSelector 的每一列掛上左滑刪除。
 * 清單都是整段 innerHTML 重畫，所以每次 render 後直接再呼叫一次即可（已包好的會跳過）。
 *
 * @param {Element} listEl      清單容器
 * @param {object}  opts
 * @param {string}  opts.rowSelector  列的選擇器，例如 ".itin-item"
 * @param {(row: Element) => void} opts.onDelete  點下紅鈕後拿到該列元素
 * @param {string}  [opts.label]      紅鈕文字
 */
export function attachSwipeDelete(listEl, { rowSelector, onDelete, label = "刪除" }) {
  if (!listEl) return;
  bindDocClose();
  listEl.querySelectorAll(rowSelector).forEach((row) => {
    if (row.parentElement?.classList.contains("swipe")) return; // 已經包過
    wrapRow(row, label, onDelete);
  });
}

function wrapRow(row, label, onDelete) {
  const wrap = document.createElement("div");
  wrap.className = "swipe";
  const del = document.createElement("button");
  del.type = "button";
  del.className = "swipe-del";
  del.textContent = label;

  row.replaceWith(wrap);
  wrap.append(del, row);

  del.onclick = (e) => {
    e.stopPropagation();
    close(wrap);
    onDelete(row);
  };

  let startX = 0, startY = 0, baseX = 0, tx = 0;
  let active = false;   // 手指/滑鼠按著
  let locked = false;   // 已判定為橫向手勢
  let swiped = false;   // 這一輪有沒有真的滑動過（用來吃掉後面那個 click）

  wrap.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".swipe-del")) return;
    active = true; locked = false; swiped = false;
    startX = e.clientX; startY = e.clientY;
    baseX = wrap.classList.contains("is-open") ? -ACTION_W : 0;
    tx = baseX;
  });

  wrap.addEventListener("pointermove", (e) => {
    if (!active) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!locked) {
      // 直向為主 → 讓瀏覽器捲動，這輪不再攔
      if (Math.abs(dy) > LOCK_PX && Math.abs(dy) > Math.abs(dx)) { active = false; return; }
      if (Math.abs(dx) < LOCK_PX) return;
      locked = true; swiped = true;
      wrap.classList.add("is-dragging");
      try { wrap.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
      if (openRow && openRow !== wrap) close(openRow);
    }
    e.preventDefault();
    tx = Math.max(-ACTION_W, Math.min(0, baseX + dx));
    setX(wrap, tx);
  });

  const end = () => {
    if (!active) return;
    active = false;
    if (!locked) return;
    locked = false;
    if (tx < -OPEN_PX) open(wrap); else close(wrap);
  };
  wrap.addEventListener("pointerup", end);
  wrap.addEventListener("pointercancel", end);

  // 這兩種 click 要在 capture 階段吃掉，否則會傳到列本身的 onclick：
  //   1. 剛滑完的那一下（支出列整列是 role=button，不擋會滑一下就跳編輯 modal）
  //   2. 已經滑開時點列身 → 當成「收回」，不是「開啟編輯」
  wrap.addEventListener("click", (e) => {
    if (e.target.closest(".swipe-del")) return;
    const justSwiped = swiped;
    swiped = false;
    if (!justSwiped && !wrap.classList.contains("is-open")) return;
    if (!justSwiped) close(wrap);
    e.stopPropagation();
    e.preventDefault();
  }, true);
}
