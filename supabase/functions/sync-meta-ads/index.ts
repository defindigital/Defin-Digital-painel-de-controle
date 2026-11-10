// Edge Function: sync-meta-ads
// Puxa investimento, alcance, cliques e leads da conta de anúncios (Meta Ads)
// para o período do ciclo do cliente. Modo admin: { client_id, deliverable_month_id }
// Modo rotina: { cron: true } + cabeçalho x-cron-secret.
import { createClient } from "jsr:@supabase/supabase-js@2";

const GRAPH_VERSION = "v21.0";
const TOKEN = Deno.env.get("META_SYSTEM_USER_TOKEN") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function periodForMonth(label: string, cycleStartDate?: string | null) {
  const [y, m] = label.split("-").map(Number);
  if (cycleStartDate) {
    const [sy, sm, sd] = String(cycleStartDate).slice(0, 10).split("-").map(Number);
    const n = (y * 12 + m) - (sy * 12 + sm);
    return {
      start: new Date(Date.UTC(sy, sm - 1, sd + 30 * n, 0, 0, 0)),
      end: new Date(Date.UTC(sy, sm - 1, sd + 30 * n + 29, 23, 59, 59)),
    };
  }
  let py = y, pm = m - 1;
  if (pm === 0) { pm = 12; py = y - 1; }
  return {
    start: new Date(Date.UTC(py, pm - 1, 23, 0, 0, 0)),
    end: new Date(Date.UTC(y, m - 1, 23, 23, 59, 59)),
  };
}
const ymd = (d: Date) => d.toISOString().slice(0, 10);

async function graphGet(path: string, params: Record<string, string | number>) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`);
  url.searchParams.set("access_token", TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString());
  const data = await res.json();
  if (data.error) {
    throw new Error(`${data.error.message || "Erro na Graph API"} (code ${data.error.code ?? "?"}, subcode ${data.error.error_subcode ?? "?"})`);
  }
  return data;
}

const LEAD_TYPES = new Set([
  "lead",
  "onsite_conversion.lead_grouped",
  "onsite_conversion.messaging_conversation_started_7d",
  "offsite_conversion.fb_pixel_lead",
]);

async function fetchAds(adAccountId: string, start: Date, end: Date) {
  const id = adAccountId.startsWith("act_") ? adAccountId : `act_${adAccountId}`;
  const until = new Date(Math.min(end.getTime(), Date.now()));
  const data = await graphGet(`${id}/insights`, {
    fields: "spend,reach,clicks,inline_link_clicks,actions",
    time_range: JSON.stringify({ since: ymd(start), until: ymd(until) }),
    level: "account",
  });
  const row = (data.data || [])[0] || {};
  const actions: { action_type: string; value: string }[] = row.actions || [];
  // evita contar duas vezes: usa "lead" se existir; senão soma mensagens/pixel
  const byType = new Map(actions.map((a) => [a.action_type, Number(a.value) || 0]));
  let leads = 0;
  if (byType.has("lead")) leads = byType.get("lead")!;
  else for (const t of LEAD_TYPES) leads += byType.get(t) || 0;
  return {
    investimento: Number(row.spend) || 0,
    alcance: Number(row.reach) || 0,
    cliques: Number(row.inline_link_clicks ?? row.clicks) || 0,
    leads,
  };
}

async function syncOne(supabase: ReturnType<typeof createClient>, client: Record<string, unknown>, month: Record<string, unknown>) {
  const { start, end } = periodForMonth(month.month_label as string, client.cycle_start_date as string | null);
  if (month.report_locked) throw new Error(`O relatório de ${month.month_label} já foi gerado; números travados.`);
  if (new Date() > end) throw new Error(`O ciclo de ${month.month_label} já se encerrou.`);
  if (new Date() < start) throw new Error(`O ciclo de ${month.month_label} ainda não começou.`);
  const vals = await fetchAds(client.ad_account_id as string, start, end);
  const { error } = await supabase.from("meta_ads_data").upsert(
    { deliverable_month_id: month.id, client_id: client.id, ...vals, last_synced_at: new Date().toISOString(), synced_auto: true },
    { onConflict: "deliverable_month_id" },
  );
  if (error) throw new Error(error.message);
  return vals;
}

async function syncPeriod(supabase: ReturnType<typeof createClient>, client: Record<string, unknown>, period: Record<string, unknown>) {
  if (period.locked) throw new Error(`O período ${period.label || period.start_date} está travado.`);
  const start = new Date(`${period.start_date}T00:00:00Z`);
  const end = new Date(`${period.end_date}T23:59:59Z`);
  if (new Date() < start) throw new Error("Este período ainda não começou.");
  const vals = await fetchAds(client.ad_account_id as string, start, end);
  const { error } = await supabase.from("meta_ads_periods")
    .update({ ...vals, last_synced_at: new Date().toISOString(), synced_auto: true })
    .eq("id", period.id as string);
  if (error) throw new Error(error.message);
  return vals;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    if (!TOKEN) return json({ error: "META_SYSTEM_USER_TOKEN não configurado." }, 500);
    const body = await req.json().catch(() => ({}));
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    if (body.cron) {
      if (!CRON_SECRET || (req.headers.get("x-cron-secret") || "") !== CRON_SECRET) return json({ error: "Não autorizado." }, 401);
      const { data: clients } = await supabase.from("clients").select("*").not("ad_account_id", "is", null);
      const summary: unknown[] = [];
      for (const c of clients || []) {
        // períodos semanais (não travados e já iniciados)
        const { data: periods } = await supabase.from("meta_ads_periods").select("*").eq("client_id", c.id).eq("locked", false);
        for (const p of periods || []) {
          if (new Date() < new Date(`${p.start_date}T00:00:00Z`)) continue;
          try { summary.push({ client: c.name, period: p.label, ...(await syncPeriod(supabase, c, p)) }); }
          catch (e) { summary.push({ client: c.name, period: p.label, error: (e as Error).message }); }
        }
        if (!(c.services || []).includes("meta_ads")) continue;
        const { data: months } = await supabase.from("deliverable_months").select("id, month_label, report_locked").eq("client_id", c.id);
        const now = new Date();
        const cur = (months || []).find((m) => {
          const p = periodForMonth(m.month_label, c.cycle_start_date);
          return !m.report_locked && now >= p.start && now <= p.end;
        });
        if (!cur) { summary.push({ client: c.name, skipped: "sem mês vigente" }); continue; }
        try { summary.push({ client: c.name, ...(await syncOne(supabase, c, cur)) }); }
        catch (e) { summary.push({ client: c.name, error: (e as Error).message }); }
      }
      return json({ ok: true, summary });
    }

    const { client_id, deliverable_month_id, period_id } = body;
    if (!client_id || (!deliverable_month_id && !period_id)) return json({ error: "client_id e deliverable_month_id são obrigatórios." }, 400);
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
    const { data: userRes } = await userClient.auth.getUser();
    if (!userRes?.user) return json({ error: "Não autenticado." }, 401);
    const { data: profile } = await supabase.from("profiles").select("role").eq("id", userRes.user.id).maybeSingle();
    if (!profile || profile.role !== "admin") return json({ error: "Apenas o admin pode sincronizar." }, 403);

    const { data: client } = await supabase.from("clients").select("*").eq("id", client_id).maybeSingle();
    if (!client) return json({ error: "Cliente não encontrado." }, 404);
    if (!client.ad_account_id) return json({ error: "Informe o ID da conta de anúncios deste cliente (painel Meta Ads)." }, 400);
    if (period_id) {
      const { data: period } = await supabase.from("meta_ads_periods").select("*").eq("id", period_id).eq("client_id", client_id).maybeSingle();
      if (!period) return json({ error: "Período não encontrado." }, 404);
      return json({ ok: true, ...(await syncPeriod(supabase, client, period)) });
    }
    const { data: month } = await supabase.from("deliverable_months").select("id, month_label, report_locked").eq("id", deliverable_month_id).eq("client_id", client_id).maybeSingle();
    if (!month) return json({ error: "Mês não encontrado." }, 404);
    return json({ ok: true, ...(await syncOne(supabase, client, month)) });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
