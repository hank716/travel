// Supabase Edge Function: ai-assist
// 金鑰只存在於此函式環境變數，前端永遠看不到：
//   supabase secrets set GEMINI_API_KEY=xxxx
//   supabase functions deploy ai-assist
//
// 前端呼叫：supabase.functions.invoke("ai-assist", { body: { mode, ... } })

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// 每次部署遞增。免費方案沒有 log，靠 diag 回傳這個值來確認線上跑的是哪一版。
const BUILD = "2026-07-25-2";

// Gemini 各世代的 thinking 參數互不相容，傳錯世代 → 400 INVALID_ARGUMENT：
//   2.5 系列：thinkingConfig.thinkingBudget（0 = 關閉思考）
//   3.x 系列：thinkingConfig.thinkingLevel（"low"/"high"，不能關閉）
// -latest 是浮動別名，Google 改版時會跨世代飄移（2026-07 的故障就是這樣來的：
// 別名飄到 3.x 後，寫死的 thinkingBudget 讓五個 mode 全部 400）。
// 所以 thinking 設定綁在「模型」上，而不是寫死成全域；最後再壓一顆固定版號的保底模型。
const GEMINI_MODELS: Array<{ id: string; thinking: Record<string, unknown> }> = [
  { id: "gemini-flash-latest", thinking: { thinkingLevel: "low" } },
  { id: "gemini-flash-lite-latest", thinking: { thinkingLevel: "low" } },
  { id: "gemini-2.5-flash", thinking: { thinkingBudget: 0 } }, // 固定版號，不會被別名飄移波及
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function apiKey(): string {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("尚未設定 GEMINI_API_KEY");
  return key;
}

function buildBody(prompt: string, thinking: Record<string, unknown>, opts: { jsonOut?: boolean; maxTokens?: number }) {
  const generationConfig: Record<string, unknown> = {
    temperature: opts.jsonOut ? 0.2 : 0.7,
    maxOutputTokens: opts.maxTokens ?? 2048,
    thinkingConfig: thinking,
  };
  if (opts.jsonOut) generationConfig.responseMimeType = "application/json";
  return JSON.stringify({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig,
  });
}

// 只取一般輸出片段，濾掉 thought（思考）片段，避免思考殘片外洩到結果。
// 註：Gemini 3.x 會在一般 text part 上掛 thoughtSignature，那不是 thought part，不能濾掉。
function extractText(data: unknown): string {
  const parts = ((data as Record<string, any>)?.candidates?.[0]?.content?.parts ?? []) as Array<{ text?: string; thought?: boolean }>;
  return parts.filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("").trim();
}

async function gemini(
  prompt: string,
  opts: { jsonOut?: boolean; maxTokens?: number; mode?: string } = {},
): Promise<{ text: string; model: string }> {
  const key = apiKey();
  const attempts: string[] = [];

  for (const model of GEMINI_MODELS) {
    const body = buildBody(prompt, model.thinking, opts); // thinking 設定因模型而異，要逐一組
    for (let attempt = 0; attempt < 3; attempt++) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent?key=${key}`;
      const res = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" }, body,
      });

      if (res.ok) {
        const data = await res.json();
        const finish = data?.candidates?.[0]?.finishReason;
        const text = extractText(data);
        // 被截斷或空結果就換下一個模型，不要把半截 JSON 往上丟
        if (finish === "MAX_TOKENS" || !text) {
          attempts.push(`${model.id} ${finish === "MAX_TOKENS" ? "輸出被截斷(MAX_TOKENS)" : "回傳空內容"}`);
          break;
        }
        return { text, model: model.id };
      }

      const t = await res.text();
      if (res.status === 503 || res.status === 429) { // 壅塞/限流 → 退避重試同一個模型
        attempts.push(`${model.id} ${res.status}`);
        await sleep(1200 * (attempt + 1));
        continue;
      }
      // 400（含參數不相容）/ 404（模型不存在）/ 其他 → 換下一個模型，不要直接放棄。
      // 舊版在這裡 throw，導致備援清單形同虛設。
      attempts.push(`${model.id} ${res.status} ${t.slice(0, 120).replace(/\s+/g, " ")}`);
      break;
    }
  }
  throw new Error(`AI 全部模型失敗${opts.mode ? `（mode=${opts.mode}）` : ""}：${attempts.join(" | ")}`);
}

// 回傳格式壞掉時要講清楚，不要靜默變空陣列讓前端顯示「沒有建議」。
function parseJson(raw: string, mode: string): unknown {
  const s = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(s);
  } catch {
    throw new Error(`AI 回傳的不是合法 JSON（mode=${mode}）：${s.slice(0, 160)}`);
  }
}

// 容錯：模型偶爾會把陣列包在物件裡回來
function asArray(parsed: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  const obj = parsed as Record<string, unknown> | null;
  for (const k of keys) if (Array.isArray(obj?.[k])) return obj![k] as unknown[];
  return [];
}

// 沒有 log 可看時的自我檢測：逐一 probe 每個模型，回報誰活著。
// 只回布林 key_set，絕不回金鑰內容。
async function diagnose() {
  const key = Deno.env.get("GEMINI_API_KEY");
  const models: Array<Record<string, unknown>> = [];
  for (const m of GEMINI_MODELS) {
    if (!key) { models.push({ id: m.id, ok: false, error: "no key" }); continue; }
    const t0 = Date.now();
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${m.id}:generateContent?key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: buildBody("ping", m.thinking, { maxTokens: 16 }),
        },
      );
      const ms = Date.now() - t0;
      if (res.ok) models.push({ id: m.id, ok: true, status: 200, ms });
      else models.push({ id: m.id, ok: false, status: res.status, ms, error: (await res.text()).slice(0, 200).replace(/\s+/g, " ") });
    } catch (e) {
      models.push({ id: m.id, ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }
  return { build: BUILD, key_set: !!key, models };
}

function weatherPrompt(payload: Record<string, unknown>): string {
  const trip = (payload.trip ?? {}) as { title?: string };
  const days = (payload.days ?? []) as Array<Record<string, unknown>>;
  const lines = days.map((d) =>
    `- ${d.date} ${d.city}：${d.condition}，氣溫 ${d.tmin ?? "?"}~${d.tmax ?? "?"}°C，降雨機率 ${d.pop ?? "?"}%${d.source === "climate" ? "（去年同期參考）" : ""}`
  ).join("\n");
  return [
    `「${trip.title ?? "這趟旅行"}」每天天氣如下：`,
    lines,
    "",
    "請用繁體中文，針對『每一天』各給建議。格式（直接照做，不要開場白、不要結尾招呼語）：",
    "**M/D（城市）** 後面接 1–2 句具體建議。",
    "每天要根據當天的實際數據給重點：",
    "- 依氣溫給穿搭（如 25°C 以上短袖、15°C 以下外套、溫差大洋蔥式）；",
    "- 降雨機率 ≥50% 一定提醒帶雨具，並建議把室內景點安排在那天；高溫/高 UV 提醒防曬補水；風大提醒。",
    "只輸出這些每日建議（純文字/Markdown），不要輸出 JSON、不要客套開頭或結尾。",
  ].join("\n");
}

// 把每天的行程地點解析成「可查天氣的行政區」
function districtsPrompt(payload: Record<string, unknown>): string {
  const days = (payload.days ?? []) as Array<Record<string, unknown>>;
  const lines = days.map((d) =>
    `- date=${d.date}｜地點：${[d.title, d.location_name, d.map_query].filter(Boolean).join("、")}`
  ).join("\n");
  return [
    "你是地理助理。根據每天的行程地點，判斷它所在的行政區，用於查詢天氣。",
    "每天回兩個欄位：",
    "- area：給人看的行政區（中文）。台灣用「縣市+區」如「高雄市左營區」；日本用「都道府縣+市區町村」如「東京都台東区」；其他國家用城市名。",
    "- geo：給地理編碼 API 搜尋用的『羅馬拼音/英文』地名（重要：不要中文、不要含上層縣市），例如左營→Zuoying、台東区→Taito、安平→Anping；若不確定區級拼音就給城市英文名，如 Kaohsiung、Tokyo、Osaka、Paris。",
    "",
    "行程：",
    lines,
    "",
    '只輸出 JSON 陣列，格式：[{"date":"YYYY-MM-DD","area":"行政區中文","geo":"RomanizedName"}]，date 必須與輸入相同。',
  ].join("\n");
}

// AI 排行程
function itineraryPrompt(payload: Record<string, unknown>): string {
  const trip = (payload.trip ?? {}) as { title?: string; start?: string; end?: string };
  const area = (payload.area as string) || "";
  const days = (payload.days as string[]) || [];
  const existing = (payload.existing as string[]) || [];
  const onlyDay = (payload.only_day as string) || "";
  // notes：使用者貼上、已自行整理的資料（可能是 Markdown）。prefs 為舊欄位，仍相容。
  const notes = ((payload.notes ?? payload.prefs) as string) || "";
  const scopeRule = onlyDay
    ? `★只規劃 ${onlyDay} 這一天★：所有項目的 day_date 必須是 ${onlyDay}，其他任何日期一律不要產生，即使參考資料提到別天也忽略。`
    : `只能輸出 day_date 在這份清單內的日期：${days.join("、") || "（依期間）"}；清單以外的日期一律不要產生。`;
  return [
    `你是專業旅遊行程規劃師。請為「${trip.title ?? "這趟旅行"}」建議行程。`,
    area ? `主要地區：${area}` : "",
    onlyDay ? `只規劃這一天：${onlyDay}` : (days.length ? `要規劃的日期：${days.join("、")}` : (trip.start ? `期間：${trip.start} ~ ${trip.end ?? ""}` : "")),
    scopeRule,
    existing.length ? `已排的項目（請勿重複，可與之串接路線）：${existing.join("、")}` : "",
    notes ? `使用者已整理的參考資料（可能為 Markdown，可能含景點/餐廳/時間/備註）。請『優先』採用其中提到的具體地點，盡量保留其名稱與順序，依地理位置補齊與排順${onlyDay ? `；只取其中屬於 ${onlyDay} 的部分` : "；缺日期者再分配到上面的日期"}：\n---\n${notes}\n---` : "",
    "",
    `${onlyDay ? "為這一天" : "為每一天"}安排 3~5 個具體景點/餐廳，依地理位置與時間排成順路、不重疊的一日動線（從早到晚）。若上面已有參考資料，以它為主、你再補強。`,
    "盡量把每個欄位都填好：start_time/end_time 給合理時段（HH:MM，24 小時制）、category 分類、location_name 完整可搜尋地名、note 一句具體建議；只有真的無法判斷的欄位才留空字串。",
    '只輸出 JSON 陣列：[{"day_date":"YYYY-MM-DD","start_time":"HH:MM","end_time":"HH:MM","title":"地點名","category":"景點|餐廳|交通|住宿|購物|其他","location_name":"可在Google地圖搜尋的完整地名","note":"一句話建議"}]。',
    "day_date 用上面指定的日期；location_name 要含城市，能被地圖搜尋。",
  ].filter(Boolean).join("\n");
}

// 對話式編輯行程：讀得到既有項目，能對它們下 update / delete / create。
// 關鍵：項目用短代號 #1/#2 溝通，絕不把 UUID 交給模型（會幻覺，寫錯就改到別筆）。
function editItineraryPrompt(payload: Record<string, unknown>): string {
  const trip = (payload.trip ?? {}) as { title?: string; start?: string; end?: string };
  const scope = (payload.scope as string) || "";
  const days = (payload.days as string[]) || [];
  const items = (payload.items ?? []) as Array<Record<string, unknown>>;
  const history = (payload.history ?? []) as Array<{ role?: string; text?: string }>;
  const message = (payload.message as string) || "";

  const itemLines = items.length
    ? items.map((i) => {
      const time = i.start_time ? `${i.start_time}${i.end_time ? `~${i.end_time}` : ""}` : "無時間";
      const extra = [i.category, i.location_name, i.note].filter(Boolean).join("｜");
      return `${i.ref} [${i.day_date || "未排定日期"} ${time}] ${i.title}${extra ? `（${extra}）` : ""}`;
    }).join("\n")
    : "（目前這個範圍內沒有任何項目）";

  const historyLines = history.length
    ? history.map((h) => `${h.role === "user" ? "使用者" : "你"}：${h.text}`).join("\n")
    : "";

  return [
    `你是「${trip.title ?? "這趟旅行"}」的行程編輯助理，用對話幫使用者調整行程。`,
    trip.start ? `旅行期間：${trip.start} ~ ${trip.end ?? trip.start}` : "",
    scope
      ? `★目前編輯範圍：只有 ${scope} 這一天★。所有異動都只能發生在 ${scope}，其他日期一律不准碰。使用者提到別天時要婉拒，並在 reply 裡告訴他解法：把視窗上方的範圍選單改成「整趟（所有日期）」就能改其他天 —— 只說不行、不給解法是不合格的回答。`
      : `目前編輯範圍：整趟。可異動的日期只有：${days.join("、") || "（依期間）"}；清單以外的日期一律不要產生。`,
    "",
    "目前行程（每筆前面的 #n 是代號，用來指定要動哪一筆）：",
    itemLines,
    historyLines ? `\n先前的對話（用來理解「再早一點」「那天也一樣」這類指代）：\n${historyLines}` : "",
    "",
    `使用者這次說：「${message}」`,
    "",
    "你可以下三種指令（ops）：",
    '- 修改：{"op":"update","ref":"#3","fields":{"start_time":"13:30","end_time":"15:00"}}',
    "  fields 只放『真的要改』的欄位，沒有要動的欄位不要出現。可用欄位：day_date, start_time, end_time, title, category, location_name, note。",
    '- 刪除：{"op":"delete","ref":"#5"}',
    '- 新增：{"op":"create","item":{"day_date":"YYYY-MM-DD","start_time":"HH:MM","end_time":"HH:MM","title":"地點名","category":"景點|餐廳|交通|住宿|購物|其他","location_name":"可在Google地圖搜尋的完整地名","note":"一句話建議"}}',
    "",
    "規則：",
    "- ref 只能用上面清單裡出現過的代號，不可自己發明；要動的項目不在清單裡就別硬掰，改成在 reply 說明。",
    `- day_date 只能是這些日期：${(scope ? [scope] : days).join("、") || "（依期間）"}。`,
    "- 時間一律 HH:MM 24 小時制。調整某一筆的時間造成後面撞期時，順手把受影響的項目也一起 update，讓整天不重疊、順路。",
    "- 新增項目時盡量把欄位填滿（location_name 要含城市、能被地圖搜尋），只有真的無法判斷才留空字串。",
    "- 使用者只是提問或閒聊（如「第二天會不會太趕？」），就回空的 ops，只用 reply 回答。",
    "- 使用者要求「重排一整天」時，優先用 update 調整既有項目，只有真的多餘才 delete、真的缺才 create。",
    "",
    "reply：用繁體中文一到三句，具體說明你做了什麼或為什麼不做，不要客套開場白。",
    '只輸出 JSON 物件：{"reply":"…","ops":[…]}。ops 沒有異動時給空陣列。',
  ].filter(Boolean).join("\n");
}

// 記帳語意解析
function expensePrompt(payload: Record<string, unknown>): string {
  const text = (payload.text as string) || "";
  const members = (payload.members as Array<{ id: string; name: string }>) || [];
  const currencies = (payload.currencies as string[]) || [];
  const base = (payload.base as string) || "";
  return [
    "你是記帳助理，把一句話拆成結構化支出。",
    `成員清單：${members.map((m) => m.name).join("、") || "（無）"}`,
    `可用幣別：${currencies.join("、") || base}（基準幣別：${base}）`,
    `句子：「${text}」`,
    "",
    "規則：",
    "- amount 數字；currency 從可用幣別猜（沒提到就用基準幣別）；",
    "- category 從 餐飲|交通|住宿|購物|門票|其他 擇一；",
    "- paid_by 是付款人名字（沒提到就留空字串）；",
    "- splits 是分攤者名字陣列（『我跟小明分』=我與小明；沒提到就空陣列代表全部均分）；",
    "- description 簡短說明。",
    '只輸出 JSON 物件：{"amount":number,"currency":"代碼","category":"類別","description":"說明","paid_by":"名字","splits":["名字"]}。',
  ].join("\n");
}

// AI 建議行李：吃天氣摘要 + 行程活動 + 偏好，產生要帶什麼。天氣模組不知道行李存在，
// 這裡只是把天氣當輸入參數的「推薦引擎」。
function packingPrompt(payload: Record<string, unknown>): string {
  const trip = (payload.trip ?? {}) as { title?: string; start?: string; end?: string };
  const days = (payload.days ?? []) as Array<Record<string, unknown>>;
  const itinerary = (payload.itinerary as string[]) || [];
  const preferences = (payload.preferences as string) || "";
  const forMember = (payload.for_member as string) || "";
  const weatherLines = days.length
    ? days.map((d) => `- ${d.date} ${d.city ?? ""}：${d.condition ?? ""}，氣溫 ${d.tmin ?? "?"}~${d.tmax ?? "?"}°C，降雨機率 ${d.pop ?? "?"}%`).join("\n")
    : "（無天氣資料，依季節常識判斷）";
  return [
    `你是旅遊行李顧問。請為「${trip.title ?? "這趟旅行"}」整理一份「要帶什麼」的行李清單。`,
    trip.start ? `期間：${trip.start} ~ ${trip.end ?? ""}` : "",
    forMember ? `這份清單是給：${forMember}` : "這份清單是「全體共用」物品（如證件、藥品、共用充電器等）。",
    "",
    "每天天氣：",
    weatherLines,
    itinerary.length ? `\n行程活動（依此判斷要帶的裝備，如登山→登山鞋、海邊→泳具）：${itinerary.join("、")}` : "",
    preferences ? `\n使用者偏好/補充：${preferences}` : "",
    "",
    "規則：",
    "- 依天氣給衣物（低溫→保暖外套、降雨→雨具、高溫高UV→防曬）；依行程活動給對應裝備；",
    "- category 從 衣物|證件|電子|盥洗|藥品|其他 擇一；qty 給合理數量（整數）；",
    forMember ? "- 以該成員個人會用到的東西為主，不要列全體共用品。" : "- 以全體會共用的東西為主（證件、藥品、轉接頭、雨傘等），不要列個人貼身衣物。",
    "- note 一句話說明為什麼帶（如「降雨機率高」「9月東京早晚涼」）。",
    "- 控制在 8~16 項，務實、不要湊數。",
    '只輸出 JSON 陣列：[{"name":"物品名","category":"衣物|證件|電子|盥洗|藥品|其他","qty":1,"note":"一句原因"}]。',
  ].filter(Boolean).join("\n");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { mode, ...payload } = await req.json().catch(() => ({}));
    switch (mode) {
      case "diag":
        return json(await diagnose());
      case "weather_suggest": {
        const { text, model } = await gemini(weatherPrompt(payload), { maxTokens: 2048, mode });
        return json({ text, _model: model });
      }
      case "resolve_districts": {
        // 這個 mode 刻意保持寬容：js/weather.js 有自己的降級路徑，
        // 不該讓地區解析失敗連帶炸掉整個天氣頁。
        try {
          const { text } = await gemini(districtsPrompt(payload), { jsonOut: true, maxTokens: 2048, mode });
          return json({ areas: asArray(parseJson(text, mode), "areas") });
        } catch {
          return json({ areas: [] });
        }
      }
      case "suggest_itinerary": {
        // 10 天行程實測要 ~4000 output token，舊值 3072 會被截斷
        const { text, model } = await gemini(itineraryPrompt(payload), { jsonOut: true, maxTokens: 8192, mode });
        return json({ items: asArray(parseJson(text, mode), "items", "itinerary"), _model: model });
      }
      case "edit_itinerary": {
        // 整趟重排會吐出大量 op，跟 suggest_itinerary 一樣要給足額度，不然被 MAX_TOKENS 截斷
        const { text, model } = await gemini(editItineraryPrompt(payload), { jsonOut: true, maxTokens: 8192, mode });
        const parsed = parseJson(text, mode) as Record<string, unknown>;
        return json({
          reply: String(parsed?.reply ?? ""),
          // 傳 parsed 而非 parsed.ops：模型偶爾會用 operations 當 key，或整包直接回陣列
          ops: asArray(parsed, "ops", "operations"),
          _model: model,
        });
      }
      case "parse_expense": {
        const { text, model } = await gemini(expensePrompt(payload), { jsonOut: true, maxTokens: 2048, mode });
        return json({ parsed: parseJson(text, mode), _model: model });
      }
      case "suggest_packing": {
        const { text, model } = await gemini(packingPrompt(payload), { jsonOut: true, maxTokens: 4096, mode });
        return json({ items: asArray(parseJson(text, mode), "items"), _model: model });
      }
      default:
        return json({ error: `不支援的 mode：${mode ?? "(空)"}` }, 400);
    }
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
