// ============================================================
// Defin Digital - Painel de Controle
// Edge Function: manage-client-access
//
// Gerencia o login de um cliente. Só o admin pode chamar.
//   action "status"       -> devolve e-mail e se o acesso está bloqueado
//   action "set_email"    -> troca o e-mail de login (email)
//   action "set_password" -> define uma senha nova (password, mín. 6)
//   action "block"        -> bloqueia o login (dados continuam guardados)
//   action "unblock"      -> libera o login de novo
// Precisa da chave "service role", por isso roda aqui e não no navegador.
// ============================================================

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  try {
    const { client_id, action, email, password } = await req.json();
    if (!client_id || !action) return json({ error: "client_id e action são obrigatórios." }, 400);

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: userRes } = await userClient.auth.getUser();
    if (!userRes?.user) return json({ error: "Não autenticado." }, 401);
    const { data: caller } = await supabase.from("profiles").select("role").eq("id", userRes.user.id).maybeSingle();
    if (!caller || caller.role !== "admin") return json({ error: "Apenas o admin pode gerenciar acessos." }, 403);

    // logins ligados a este cliente (perfis que não são admin)
    const { data: profs } = await supabase.from("profiles").select("id, role").eq("client_id", client_id);
    const ids = (profs || []).filter((p: { role: string }) => p.role !== "admin").map((p: { id: string }) => p.id);

    if (action === "status") {
      const logins = [];
      for (const id of ids) {
        const { data } = await supabase.auth.admin.getUserById(id);
        const u = data?.user;
        if (u) {
          const bannedUntil = (u as { banned_until?: string | null }).banned_until;
          logins.push({ id: u.id, email: u.email, blocked: !!bannedUntil && new Date(bannedUntil) > new Date() });
        }
      }
      return json({ ok: true, logins });
    }

    if (!ids.length) return json({ error: "Este cliente ainda não tem login. Crie o acesso primeiro." }, 404);

    if (action === "set_email") {
      const clean = String(email || "").trim().toLowerCase();
      if (!clean || !clean.includes("@")) return json({ error: "E-mail inválido." }, 400);
      for (const id of ids) {
        const { error } = await supabase.auth.admin.updateUserById(id, { email: clean, email_confirm: true });
        if (error) return json({ error: error.message }, 400);
      }
      return json({ ok: true });
    }

    if (action === "set_password") {
      if (!password || String(password).length < 6) return json({ error: "A senha precisa ter pelo menos 6 caracteres." }, 400);
      for (const id of ids) {
        const { error } = await supabase.auth.admin.updateUserById(id, { password: String(password) });
        if (error) return json({ error: error.message }, 400);
      }
      return json({ ok: true });
    }

    if (action === "block" || action === "unblock") {
      for (const id of ids) {
        const { error } = await supabase.auth.admin.updateUserById(id, { ban_duration: action === "block" ? "876000h" : "none" });
        if (error) return json({ error: error.message }, 400);
      }
      return json({ ok: true });
    }

    return json({ error: "Ação desconhecida." }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
