// ============================================================
// Defin Digital - Painel de Controle
// Edge Function: sync-deliverables
//
// Conta as publicações do Instagram e do Facebook (posts do feed, reels
// e stories) dentro do CICLO de cada cliente e atualiza "feitos" nos
// Entregáveis do mês (posts_done, reels_done, stories_done).
//
// Regras:
//  - O período é o do ciclo do cliente (mesma conta da sync-meta-insights:
//    data de início + 30 dias, ou dia fixo 23 → 23 nos clientes antigos).
//  - Posts e reels: a API devolve o histórico, então a contagem do ciclo
//    inteiro é recalculada a cada rodada.
//  - Stories: a API só mostra os das últimas 24h. Por isso cada rodada
//    guarda os stories que encontra (tabela published_media) e a contagem
//    do ciclo soma o que foi guardado. Stories anteriores ao início da
//    rotina não aparecem — o admin ajusta o número na mão.
//  - Número editado na mão pelo admin (deliverables_manual) NÃO é
//    sobrescrito, a não ser que o admin peça "recalcular tudo" (force).
//  - Instagram é a fonte principal. Se o cliente não tem Instagram
//    ativo, usa o Facebook.
//  - Mês encerrado ou com relatório gerado nunca é alterado.
//
// Dois modos de chamada:
//  1) Admin, pelo painel: { client_id, deliverable_month_id, force? }
//     com o login do admin.
//  2) Rotina diária (cron): { cron: true } com o cabeçalho x-cron-secret
//     igual à secret CRON_SECRET. Processa todos os clientes, no mês
//     do ciclo em andamento.
//
// Secrets: META_SYSTEM_USER_TOKEN, CRON_SECRET (só para a rotina).
// ============================================================

import { createClient } from "jsr:@supabase/supabase-js@2";

const GRAPH = "https://graph.facebook.com/v21.0";
const TOKEN = Deno.env.get("META_SYSTEM_USER_TOKEN") || "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

type Kind = "post" | "reel" | "story";
interface Media { platform: string; media_id: string; kind: Kind; published_at: string; permalink: string | null }

// ---------- período do ciclo (igual à sync-meta-insights) ----------
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

// ---------- Graph API ----------
async function getJson(url: string): Promise<any> {
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) {
    throw new Error(`${data.error.message || "Erro na Graph API"} (code ${data.error.code ?? "?"})`);
  }
  return data;
}
function edgeUrl(path: string, fields: string) {
  const u = new URL(`${GRAPH}/${path}`);
  u.searchParams.set("fields", fields);
  u.searchParams.set("limit", "100");
  u.searchParams.set("access_token", TOKEN);
  return u.toString();
}
// percorre as páginas (mais novo → mais antigo) até passar do início do ciclo
async function listEdge(path: string, fields: string, timeOf: (x: any) => number, sinceMs: number): Promise<any[]> {
  const out: any[] = [];
  let url: string | undefined = edgeUrl(path, fields);
  for (let page = 0; page < 12 && url; page++) {
    const data = await getJson(url);
    const items: any[] = data.data || [];
    out.push(...items);
    const times = items.map(timeOf).filter((t) => !isNaN(t));
    if (times.length && Math.min(...times) < sinceMs) break;
    url = data.paging?.next;
  }
  return out;
}
const toMs = (v: unknown): number => {
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  return Date.parse(String(v));
};

async function collectInstagram(igId: string, sinceMs: number, warnings: string[]): Promise<Media[]> {
  const media: Media[] = [];
  try {
    const items = await listEdge(`${igId}/media`, "id,media_product_type,media_type,timestamp,permalink", (x) => toMs(x.timestamp), sinceMs);
    for (const it of items) {
      const ts = toMs(it.timestamp);
      if (isNaN(ts)) continue;
      const isReel = it.media_product_type === "REELS";
      media.push({ platform: "instagram", media_id: String(it.id), kind: isReel ? "reel" : "post", published_at: new Date(ts).toISOString(), permalink: it.permalink || null });
    }
  } catch (e) {
    warnings.push("Instagram (posts/reels): " + (e as Error).message);
  }
  try {
    const data = await getJson(edgeUrl(`${igId}/stories`, "id,media_type,timestamp,permalink"));
    for (const it of data.data || []) {
      const ts = toMs(it.timestamp);
      if (isNaN(ts)) continue;
      media.push({ platform: "instagram", media_id: String(it.id), kind: "story", published_at: new Date(ts).toISOString(), permalink: it.permalink || null });
    }
  } catch (e) {
    warnings.push("Instagram (stories): " + (e as Error).message);
  }
  return media;
}

async function collectFacebook(pageId: string, sinceMs: number, warnings: string[]): Promise<Media[]> {
  const media: Media[] = [];
  try {
    const items = await listEdge(`${pageId}/published_posts`, "id,created_time,permalink_url", (x) => toMs(x.created_time), sinceMs);
    for (const it of items) {
      const ts = toMs(it.created_time);
      if (isNaN(ts)) continue;
      media.push({ platform: "facebook", media_id: String(it.id), kind: "post", published_at: new Date(ts).toISOString(), permalink: it.permalink_url || null });
    }
  } catch (e) {
    warnings.push("Facebook (posts): " + (e as Error).message);
  }
  try {
    const items = await listEdge(`${pageId}/video_reels`, "id,created_time,permalink_url", (x) => toMs(x.created_time), sinceMs);
    for (const it of items) {
      const ts = toMs(it.created_time);
      if (isNaN(ts)) continue;
      media.push({ platform: "facebook", media_id: "reel_" + String(it.id), kind: "reel", published_at: new Date(ts).toISOString(), permalink: it.permalink_url || null });
    }
  } catch (e) {
    warnings.push("Facebook (reels): " + (e as Error).message);
  }
  try {
    const data = await getJson(edgeUrl(`${pageId}/stories`, "post_id,creation_time,url,status"));
    for (const it of data.data || []) {
      const ts = toMs(it.creation_time);
      if (isNaN(ts)) continue;
      media.push({ platform: "facebook", media_id: "story_" + String(it.post_id || it.id), kind: "story", published_at: new Date(ts).toISOString(), permalink: it.url || null });
    }
  } catch (e) {
    warnings.push("Facebook (stories): " + (e as Error).message);
  }
  return media;
}

// ---------- sincroniza um cliente ----------
// Guarda as publicações encontradas e atualiza os meses (do ciclo em
// andamento, ou o mês pedido) que ainda não estão travados.
async function syncClient(supabase: ReturnType<typeof createClient>, client: any, onlyMonthId: string | null, force: boolean) {
  const warnings: string[] = [];
  const channels: string[] | null = Array.isArray(client.social_channels) ? client.social_channels : null;
  const wantsIg = !!client.ig_business_id && (!channels || channels.includes("instagram"));
  const wantsFb = !!client.fb_page_id && (!channels || channels.includes("facebook"));
  if (!wantsIg && !wantsFb) {
    return { ok: false, warnings: ["Nenhum canal Instagram/Facebook ativo e configurado para este cliente."], months: [] as unknown[] };
  }

  const { data: monthRows } = await supabase.from("deliverable_months").select("*").eq("client_id", client.id);
  const now = new Date();
  const targets = (monthRows || []).filter((m: any) => {
    if (onlyMonthId) return m.id === onlyMonthId;
    const { start, end } = periodForMonth(m.month_label, client.cycle_start_date);
    return now >= start && now <= end;
  });

  // quanto da história precisamos buscar: do início do ciclo mais antigo envolvido
  const starts = targets.map((m: any) => periodForMonth(m.month_label, client.cycle_start_date).start.getTime());
  const sinceMs = starts.length ? Math.min(...starts) : now.getTime() - 35 * 86400000;

  const collected: Media[] = [];
  if (wantsIg) collected.push(...await collectInstagram(client.ig_business_id, sinceMs, warnings));
  if (wantsFb) collected.push(...await collectFacebook(client.fb_page_id, sinceMs, warnings));

  if (collected.length) {
    const rows = collected.map((m) => ({ client_id: client.id, ...m }));
    const { error } = await supabase.from("published_media").upsert(rows, { onConflict: "client_id,platform,media_id" });
    if (error) warnings.push("Gravação das publicações: " + error.message);
  }

  const primary = wantsIg ? "instagram" : "facebook";
  const results: unknown[] = [];
  for (const m of targets) {
    const { start, end } = periodForMonth(m.month_label, client.cycle_start_date);
    if (m.report_locked || now > end) {
      results.push({ month: m.month_label, skipped: "mês encerrado ou com relatório gerado" });
      continue;
    }
    const { data: inRange } = await supabase.from("published_media").select("kind")
      .eq("client_id", client.id).eq("platform", primary)
      .gte("published_at", start.toISOString()).lte("published_at", end.toISOString());
    const count = { posts: 0, reels: 0, stories: 0 };
    for (const r of inRange || []) {
      if (r.kind === "post") count.posts++;
      else if (r.kind === "reel") count.reels++;
      else if (r.kind === "story") count.stories++;
    }
    const manual: Record<string, boolean> = force ? {} : (m.deliverables_manual || {});
    const update: Record<string, unknown> = { deliverables_synced_at: now.toISOString() };
    const applied: Record<string, number> = {};
    const skippedManual: string[] = [];
    for (const [field, value] of [["posts_done", count.posts], ["reels_done", count.reels], ["stories_done", count.stories]] as [string, number][]) {
      if (manual[field]) { skippedManual.push(field); continue; }
      update[field] = value; applied[field] = value;
    }
    if (force) update.deliverables_manual = {};
    const { error } = await supabase.from("deliverable_months").update(update).eq("id", m.id);
    if (error) warnings.push(`Atualização de ${m.month_label}: ${error.message}`);
    results.push({ month: m.month_label, period: `${start.toISOString().slice(0, 10)} a ${end.toISOString().slice(0, 10)}`, source: primary, counted: count, applied, skippedManual });
  }
  return { ok: true, warnings, months: results };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    if (!TOKEN) return json({ error: "META_SYSTEM_USER_TOKEN não configurado nas Secrets." }, 500);
    const body = await req.json().catch(() => ({}));
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // ----- modo rotina diária -----
    if (body.cron) {
      const sent = req.headers.get("x-cron-secret") || "";
      if (!CRON_SECRET || sent !== CRON_SECRET) return json({ error: "Não autorizado." }, 401);
      const { data: clients } = await supabase.from("clients").select("*");
      const summary: unknown[] = [];
      for (const c of clients || []) {
        if (!c.ig_business_id && !c.fb_page_id) continue;
        try {
          const r = await syncClient(supabase, c, null, false);
          summary.push({ client: c.name, ...r });
        } catch (e) {
          summary.push({ client: c.name, error: (e as Error).message });
        }
      }
      console.log("Rotina diária:", JSON.stringify(summary));
      return json({ ok: true, summary });
    }

    // ----- modo admin -----
    const { client_id, deliverable_month_id, force } = body;
    if (!client_id || !deliverable_month_id) return json({ error: "client_id e deliverable_month_id são obrigatórios." }, 400);

    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: userRes } = await userClient.auth.getUser();
    if (!userRes?.user) return json({ error: "Não autenticado." }, 401);
    const { data: profile } = await supabase.from("profiles").select("role").eq("id", userRes.user.id).maybeSingle();
    if (!profile || profile.role !== "admin") return json({ error: "Apenas o admin pode sincronizar." }, 403);

    const { data: client } = await supabase.from("clients").select("*").eq("id", client_id).maybeSingle();
    if (!client) return json({ error: "Cliente não encontrado." }, 404);
    const { data: month } = await supabase.from("deliverable_months").select("id, month_label, report_locked").eq("id", deliverable_month_id).eq("client_id", client_id).maybeSingle();
    if (!month) return json({ error: "Mês não encontrado para este cliente." }, 404);

    const { end, start } = periodForMonth(month.month_label, client.cycle_start_date);
    if (month.report_locked) return json({ error: `O relatório de ${month.month_label} já foi gerado e os números estão travados.` }, 400);
    if (new Date() > end) return json({ error: `O ciclo de ${month.month_label} já se encerrou. Não é possível sincronizar um mês fechado.` }, 400);
    if (new Date() < start) return json({ error: `O ciclo de ${month.month_label} ainda não começou.` }, 400);

    const r = await syncClient(supabase, client, month.id, !!force);
    return json(r);
  } catch (e) {
    console.log("Erro geral:", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
