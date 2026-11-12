// Edge Function: notify-themes
// Avisa o cliente por e-mail que há uma semana de temas aguardando aprovação.
// Body (admin): { client_id, week_id }
// Secrets: RESEND_API_KEY (obrigatória p/ enviar), RESEND_FROM (opcional), PANEL_URL (opcional)
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const RESEND_FROM = Deno.env.get("RESEND_FROM") || "Defin Digital <painel@defindigital.com.br>";
const PANEL_URL = Deno.env.get("PANEL_URL") || "https://paineldecontrole.defindigital.com.br";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const br = (d: string) => d.slice(8, 10) + "/" + d.slice(5, 7);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const { client_id, week_id } = await req.json().catch(() => ({}));
    if (!client_id || !week_id) return json({ error: "client_id e week_id são obrigatórios." }, 400);
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
    const { data: u } = await userClient.auth.getUser();
    if (!u?.user) return json({ error: "Não autenticado." }, 401);
    const { data: prof } = await supabase.from("profiles").select("role").eq("id", u.user.id).maybeSingle();
    if (!prof || prof.role !== "admin") return json({ error: "Apenas o admin." }, 403);

    const { data: week } = await supabase.from("theme_weeks").select("*").eq("id", week_id).eq("client_id", client_id).maybeSingle();
    if (!week) return json({ error: "Semana não encontrada." }, 404);
    const { data: items } = await supabase.from("theme_items").select("*").eq("week_id", week_id).eq("status", "aguardando").order("sort_order");
    const { data: client } = await supabase.from("clients").select("name").eq("id", client_id).maybeSingle();
    const { data: logins } = await supabase.from("profiles").select("id").eq("client_id", client_id);
    const emails: string[] = [];
    for (const l of logins || []) {
      const { data } = await supabase.auth.admin.getUserById(l.id as string);
      if (data?.user?.email) emails.push(data.user.email);
    }
    if (!emails.length) return json({ sent: false, reason: "Este cliente não tem login com e-mail cadastrado." });
    if (!RESEND_API_KEY) return json({ sent: false, reason: "E-mail ainda não configurado (falta a secret RESEND_API_KEY). O aviso aparece dentro do painel do cliente." });

    const list = (items || []).map((i) => `<li><strong>${i.post_date ? br(String(i.post_date)) + " · " : ""}</strong>${esc(String(i.title))}</li>`).join("");
    const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#1b2733">
      <h2 style="margin:0 0 8px">Temas da semana ${br(String(week.week_start))} a ${br(String(week.week_end))}</h2>
      <p style="font-size:16px"><strong>Tema:</strong> ${esc(String(week.theme))}</p>
      <p>Olá! Há <strong>${(items || []).length}</strong> publicação(ões) aguardando a sua aprovação:</p>
      <ul style="line-height:1.6">${list}</ul>
      <p><a href="${PANEL_URL}" style="display:inline-block;background:#1e9e5a;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">Abrir o painel e aprovar</a></p>
      <p style="color:#6b7886;font-size:13px">Você pode aprovar, recusar ou sugerir outro tema em cada publicação.</p></div>`;
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: RESEND_FROM, to: emails, subject: `Temas da semana para aprovar — ${client?.name || "Defin Digital"}`, html }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) return json({ sent: false, reason: "Falha no envio: " + (out.message || r.status) });
    return json({ sent: true, to: emails.length });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
