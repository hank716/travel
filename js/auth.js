// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Hank Wang

// 認證：管理員用 Email、成員用使用者名稱（合成 email）。
import { supabase } from "@/supabase.js";

// 成員使用者名稱合成的 email 網域（無真實收信，僅作 Supabase 帳號識別）
const MEMBER_DOMAIN = "guest.tripplanner.app";

// 把「帳號」正規化成 email：含 @ 視為 email，否則補成員網域
export function toEmail(idOrEmail) {
  const v = (idOrEmail || "").trim();
  if (!v) return "";
  return v.includes("@") ? v.toLowerCase() : `${v.toLowerCase()}@${MEMBER_DOMAIN}`;
}

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session || null;
}

export async function login(idOrEmail, password) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: toEmail(idOrEmail), password,
  });
  if (error) throw error;
  return data.user;
}

// 註冊管理員（真 Email + 密碼 + 使用者名稱）
export async function registerAdmin(email, password, username) {
  const { data, error } = await supabase.auth.signUp({
    email: email.trim().toLowerCase(),
    password,
    options: { data: { username: (username || "").trim() || null } },
  });
  if (error) throw error;
  return data.user;
}

export async function logout() {
  await supabase.auth.signOut();
}

// 目前登入者的 profile（含 is_admin / username）
export async function getProfile() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from("profiles").select("*").eq("id", user.id).maybeSingle();
  if (error) throw error;
  return { ...data, email: user.email, id: user.id };
}

// 改自己的顯示名稱。profiles 是唯一來源，members.display_name 只是快取副本，
// 一起帶著改，否則成員清單／付款人／分帳／行李歸屬還會停在舊名字。
// （profiles 只開放 update display_name 這一欄，改不到 is_admin —— 見 schema.sql 的欄位級 grant）
export async function updateMyDisplayName(name) {
  const display_name = (name || "").trim();
  if (!display_name) throw new Error("請輸入顯示名稱");
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("尚未登入");
  const { error } = await supabase.from("profiles").update({ display_name }).eq("id", user.id);
  if (error) throw error;
  // members_update_own 政策允許本人改自己的成員列
  await supabase.from("members").update({ display_name }).eq("auth_uid", user.id);
  return display_name;
}

// 改自己的密碼。updateUser 只認 session、不驗舊密碼，所以先拿「目前密碼」重登一次當驗證，
// 免得有人趁沒鎖螢幕就把別人的密碼換掉。重登的是同一個帳號，不會被登出。
export async function changeMyPassword(current, next) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) throw new Error("尚未登入");
  const { error: verifyErr } = await supabase.auth.signInWithPassword({
    email: user.email, password: current,
  });
  if (verifyErr) {
    const e = new Error("目前密碼不正確。");
    e.code = "bad_current_password";
    throw e;
  }
  const { error } = await supabase.auth.updateUser({ password: next });
  if (error) throw error;
}

export function onAuthChange(cb) {
  return supabase.auth.onAuthStateChange((_event, session) => cb(session));
}
