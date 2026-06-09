// 共用常數：幣別清單、成員配色。

// 常見幣別（可自由增減；每趟行程在 DB 各自存啟用清單）
export const CURRENCIES = {
  JPY: { name: "日圓",   symbol: "¥",  flag: "🇯🇵" },
  TWD: { name: "新台幣", symbol: "NT$", flag: "🇹🇼" },
  USD: { name: "美元",   symbol: "$",  flag: "🇺🇸" },
  EUR: { name: "歐元",   symbol: "€",  flag: "🇪🇺" },
  KRW: { name: "韓元",   symbol: "₩",  flag: "🇰🇷" },
  CNY: { name: "人民幣", symbol: "¥",  flag: "🇨🇳" },
  HKD: { name: "港幣",   symbol: "HK$", flag: "🇭🇰" },
  GBP: { name: "英鎊",   symbol: "£",  flag: "🇬🇧" },
  THB: { name: "泰銖",   symbol: "฿",  flag: "🇹🇭" },
  SGD: { name: "新加坡幣", symbol: "S$", flag: "🇸🇬" },
};

export const CURRENCY_CODES = Object.keys(CURRENCIES);

// 成員頭像配色（建立/加入時自動輪流挑一個）
export const MEMBER_COLORS = [
  "#E66F4B", "#5E7C58", "#D59A39", "#4B79E6",
  "#9B59B6", "#E6699B", "#2BB6A8", "#C0563B",
];

export function pickColor(usedColors = []) {
  const free = MEMBER_COLORS.find((c) => !usedColors.includes(c));
  return free || MEMBER_COLORS[Math.floor(Math.random() * MEMBER_COLORS.length)];
}
