// ============================================================
// Defin Digital - Painel de Controle
// Edge Function: delete-client
//
// Exclui um cliente por completo: login (usuário de autenticação),
// perfil, meses, métricas de redes sociais, calendário, checklist,
// relatórios, proposta, cobrança e dados de Meta Ads / Google Meu
// Negócio. Não pode ser desfeito.
//
// Por que isso precisa ser uma Edge Function: apagar o usuário de
// autenticação exige a chave "service role", que nunca pode ficar
// no código do navegador. Só quem já está logado como admin pode
// chamar essa função.
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
    const { client_id } = await req.json();
    if (!client_id) return json({ error: "client_id é obrigatório." }, 400);

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // só admin pode excluir cliente
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: userRes } = await userClient.auth.getUser();
    if (!userRes?.user) return json({ error: "Não autenticado." }, 401);
    const { data: callerProfile } = await supabase.from("profiles").select("role").eq("id", userRes.user.id).maybeSingle();
    if (!callerProfile || callerProfile.role !== "admin") {
      return json({ error: "Apenas o admin pode excluir clientes." }, 403);
    }

    const { data: client, error: clientErr } = await supabase.from("clients").select("id, name").eq("id", client_id).maybeSingle();
    if (clientErr || !client) return json({ error: "Cliente não encontrado." }, 404);

    // ids dos meses do cliente, usados pra apagar tudo que depende de "deliverable_month_id"
    const { data: months } = await supabase.from("deliverable_months").select("id").eq("client_id", client_id);
    const monthIds = (months || []).map((m: { id: string }) => m.id);

    const warnings: string[] = [];
    async function safeDelete(table: string, column: string, value: string | string[]) {
      if (Array.isArray(value) && value.length === 0) return;
      const query = supabase.from(table).delete();
      const { error } = Array.isArray(value) ? await query.in(column, value) : await query.eq(column, value);
      if (error) warnings.push(`${table}: ${error.message}`);
    }

    // apaga tudo que depende de deliverable_month_id
    if (monthIds.length) {
      await safeDelete("social_insights", "deliverable_month_id", monthIds);
      await safeDelete("calendar_posts", "deliverable_month_id", monthIds);
      await safeDelete("checklist_items", "deliverable_month_id", monthIds);
      await safeDelete("monthly_reports", "deliverable_month_id", monthIds);
      await safeDelete("meta_ads_data", "deliverable_month_id", monthIds);
      await safeDelete("gmn_data", "deliverable_month_id", monthIds);
    }
    await safeDelete("deliverable_months", "client_id", client_id);
    await safeDelete("proposals", "client_id", client_id);
    await safeDelete("client_billing", "client_id", client_id);

    // apaga o login (auth user) de quem estiver ligado a este cliente
    const { data: profiles } = await supabase.from("profiles").select("id").eq("client_id", client_id);
    for (const p of profiles || []) {
      await supabase.auth.admin.deleteUser(p.id as string).catch((e: Error) => warnings.push(`auth user ${p.id}: ${e.message}`));
    }
    await safeDelete("profiles", "client_id", client_id);

    // por último, o próprio cliente
    const { error: delClientErr } = await supabase.from("clients").delete().eq("id", client_id);
    if (delClientErr) return json({ error: "Erro ao excluir cliente: " + delClientErr.message, warnings }, 500);

    return json({ ok: true, warnings }, 200);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
