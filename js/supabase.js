// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Hank Wang

// Supabase client（Email/密碼帳號制）。
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.APP_CONFIG;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storageKey: "jp-trip-auth",
  },
});

// 共用的 postgres_changes 訂閱工具，回傳取消訂閱函式。
// 為什麼不直接 supabase.channel("trip-" + id)：removeChannel() 是非同步的，
// 上一輪的 channel 還沒清掉時，supabase-js 會把「既有、已 subscribe 過的」同名
// channel 原封不動還回來，這時再 .on("postgres_changes") 就會丟
// 「cannot add postgres_changes callbacks ... after subscribe()」，
// 而且是同步 throw，會把呼叫端（enterTrip）整個打斷。
// 所以每次都給唯一 topic，並順手收掉同前綴的殘留頻道。
let channelSeq = 0;
export function subscribeChannel(name, bindings, onChange) {
  supabase.getChannels()
    .filter((c) => c.topic.startsWith(`realtime:${name}#`))
    .forEach((c) => supabase.removeChannel(c));
  const channel = supabase.channel(`${name}#${++channelSeq}`);
  for (const b of bindings) channel.on("postgres_changes", b, onChange);
  channel.subscribe();
  let done = false;
  return () => { if (done) return; done = true; supabase.removeChannel(channel); };
}
