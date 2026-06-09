// 認證：管理員用 Email、成員用使用者名稱（合成 email）。
import { supabase } from "./supabase.js";

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

export function onAuthChange(cb) {
  return supabase.auth.onAuthStateChange((_event, session) => cb(session));
}
