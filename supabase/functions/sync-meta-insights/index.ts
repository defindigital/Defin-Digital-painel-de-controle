// ============================================================
// Defin Digital - Painel de Controle
// Edge Function: sync-meta-insights  (v4 — ciclos de 30 dias + canais por cliente)
//
// Diferença desta versão: em vez de usar o mês "de hoje" (calculado
// pelo relógio do servidor), a função agora recebe o ID do mês que
// o admin selecionou no painel (deliverable_month_id) e calcula o
// período de referência daquele mês: do dia 23 do mês anterior até
// o dia 23 do próprio mês (ex: mês "2026-10" = 23/09 a 23/10).
// Isso deixa a sincronização sempre alinhada ao ciclo de fechamento
// da Defin Digital, em vez de pegar o mês corrido do calendário.
//
// Mantém os logs de diagnóstico e o aviso de erro de gravação no
// banco da versão anterior.
//
// Secrets necessárias (configuradas no projeto Supabase, nunca no código):
//   META_SYSTEM_USER_TOKEN  -> token do Usuário de Sistema "Painel API"
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já existem automaticamente
// dentro de toda Edge Function do Supabase, não precisa configurar.
// ============================================================

import { createClient } from "jsr:@supabase/supabase-js@2";

const GRAPH_VERSION = "v21.0";
const SYSTEM_USER_TOKEN = Deno.env.get("META_SYSTEM_USER_TOKEN") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// Período de referência do ciclo:
//  - Cliente com data de início (cycle_start_date): ciclos de 30 dias. O mês da
//    data de início é o ciclo 1 (início 01/11: "2026-11" = 01/11 a 30/11,
//    "2026-12" = 01/12 a 30/12, ...).
//  - Cliente antigo, sem data: do dia 23 do mês anterior até o dia 23 do mês.
function periodForMonth(label: string, cycleStartDate?: string | null) {
  const [y, m] = label.split("-").map(Number);
  if (cycleStartDate) {
    const [sy, sm, sd] = String(cycleStartDate).slice(0, 10).split("-").map(Number);
    const n = (y * 12 + m) - (sy * 12 + sm);
    const start = new Date(Date.UTC(sy, sm - 1, sd + 30 * n, 0, 0, 0));
    const end = new Date(Date.UTC(sy, sm - 1, sd + 30 * n + 29, 23, 59, 59));
    return { start, end };
  }
  let py = y, pm = m - 1;
  if (pm === 0) { pm = 12; py = y - 1; }
  const start = new Date(Date.UTC(py, pm - 1, 23, 0, 0, 0));
  const end = new Date(Date.UTC(y, m - 1, 23, 23, 59, 59));
  return { start, end };
}

async function graphGet(path: string, params: Record<string, string | number> = {}) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`);
  url.searchParams.set("access_token", SYSTEM_USER_TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const safeUrl = url.toString().replace(SYSTEM_USER_TOKEN, "***TOKEN***");
  console.log("Chamando Graph API:", safeUrl);

  const res = await fetch(url.toString());
  const data = await res.json();
  console.log("Resposta da Graph API para", path, ":", JSON.stringify(data).replace(SYSTEM_USER_TOKEN, "***TOKEN***"));

  if (data.error) {
    throw new Error(
      `${data.error.message || "Erro desconhecido na Graph API"} (code ${data.error.code ?? "?"}, subcode ${data.error.error_subcode ?? "?"})`
    );
  }
  return data;
}

async function syncInstagram(igId: string, since: number, until: number) {
  const basic = await graphGet(igId, { fields: "followers_count,media_count" });

  const insights: Record<string, number> = {};
  const warnings: string[] = [];
  try {
    const ins = await graphGet(`${igId}/insights`, {
      metric: "reach,profile_views,accounts_engaged,total_interactions,website_clicks",
      period: "day",
      metric_type: "total_value",
      since,
      until,
    });
    for (const item of ins.data || []) {
      insights[item.name] = item.total_value?.value ?? 0;
    }
  } catch (e) {
    console.log("Instagram insights falhou:", (e as Error).message);
    warnings.push("Instagram insights: " + (e as Error).message);
  }

  return {
    followers: basic.followers_count ?? 0,
    views: insights.reach ?? 0,
    profile_visits: insights.profile_views ?? 0,
    interactions: insights.total_interactions ?? insights.accounts_engaged ?? 0,
    link_clicks: insights.website_clicks ?? 0,
    _mediaCount: basic.media_count ?? 0,
    _warnings: warnings,
  };
}

async function syncFacebook(pageId: string, since: number, until: number) {
  const warnings: string[] = [];
  const basic = await graphGet(pageId, { fields: "followers_count,fan_count" }).catch((e) => {
    console.log("Facebook basic falhou:", (e as Error).message);
    warnings.push("Facebook (dados básicos): " + (e as Error).message);
    return {} as Record<string, number>;
  });

  const insights: Record<string, number> = {};
  const metricsToTry: { metric: string; period: string }[] = [
    { metric: "page_impressions_unique", period: "day" },
    { metric: "page_post_engagements", period: "day" },
    { metric: "page_views_total", period: "day" },
    { metric: "page_fans", period: "day" },
  ];
  for (const m of metricsToTry) {
    try {
      const ins = await graphGet(`${pageId}/insights`, { metric: m.metric, period: m.period, since, until });
      for (const item of ins.data || []) {
        const total = (item.values || []).reduce((s: number, v: { value?: number }) => s + (Number(v.value) || 0), 0);
        insights[item.name] = total;
      }
    } catch (e) {
      console.log(`Facebook insights (${m.metric}) falhou:`, (e as Error).message);
      warnings.push(`Facebook insights (${m.metric}): ${(e as Error).message}`);
    }
  }

  return {
    followers: (basic as Record<string, number>).followers_count ?? (basic as Record<string, number>).fan_count ?? 0,
    views: insights.page_impressions_unique ?? insights.page_views_total ?? 0,
    interactions: insights.page_post_engagements ?? 0,
    _warnings: warnings,
  };
}

async function upsertInsight(
  supabase: ReturnType<typeof createClient>,
  clientId: string,
  monthId: string,
  platform: string,
  data: Record<string, number>,
): Promise<string | null> {
  const { data: existing } = await supabase
    .from("social_insights")
    .select("id, followers")
    .eq("deliverable_month_id", monthId)
    .eq("platform", platform)
    .maybeSingle();

  const payload: Record<string, unknown> = {
    followers: data.followers,
    views: data.views,
    interactions: data.interactions,
    last_synced_at: new Date().toISOString(),
  };
  if ("profile_visits" in data) payload.profile_visits = data.profile_visits;
  if ("link_clicks" in data) payload.link_clicks = data.link_clicks;

  if (existing) {
    if (existing.followers != null && data.followers != null) {
      payload.new_followers = Math.max(0, data.followers - (existing.followers as number));
    }
    const { error } = await supabase.from("social_insights").update(payload).eq("id", existing.id as string);
    if (error) {
      console.log(`Erro ao ATUALIZAR social_insights (${platform}):`, JSON.stringify(error));
      return error.message || JSON.stringify(error);
    }
  } else {
    const { error } = await supabase.from("social_insights").insert({
      client_id: clientId,
      deliverable_month_id: monthId,
      platform,
      new_followers: data.followers ?? 0,
      ...payload,
    });
    if (error) {
      console.log(`Erro ao INSERIR social_insights (${platform}):`, JSON.stringify(error));
      return error.message || JSON.stringify(error);
    }
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  try {
    if (!SYSTEM_USER_TOKEN) {
      return json({ error: "META_SYSTEM_USER_TOKEN não configurado nas Secrets do projeto Supabase." }, 500);
    }

    const { client_id, deliverable_month_id } = await req.json();
    if (!client_id) return json({ error: "client_id é obrigatório" }, 400);
    if (!deliverable_month_id) return json({ error: "deliverable_month_id é obrigatório" }, 400);

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // só admin pode disparar a sincronização
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userRes } = await userClient.auth.getUser();
    if (!userRes?.user) return json({ error: "Não autenticado." }, 401);

    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", userRes.user.id)
      .maybeSingle();
    if (!profile || profile.role !== "admin") {
      return json({ error: "Apenas o admin pode sincronizar." }, 403);
    }

    const { data: client, error: clientErr } = await supabase
      .from("clients")
      .select("*")
      .eq("id", client_id)
      .maybeSingle();
    if (clientErr || !client) return json({ error: "Cliente não encontrado." }, 404);

    const { data: month, error: monthErr } = await supabase
      .from("deliverable_months")
      .select("id, month_label, report_locked")
      .eq("id", deliverable_month_id)
      .eq("client_id", client_id)
      .maybeSingle();
    if (monthErr || !month) return json({ error: "Mês não encontrado para este cliente." }, 404);

    const monthLabel = month.month_label as string;
    const { start, end } = periodForMonth(monthLabel, (client.cycle_start_date as string | null) ?? null);
    const now = new Date();
    const since = Math.floor(start.getTime() / 1000);
    const until = Math.min(Math.floor(end.getTime() / 1000), Math.floor(now.getTime() / 1000));
    console.log(
      "Mês:", monthLabel,
      "| Período travado:", start.toISOString(), "a", end.toISOString(),
      "| Usado na consulta (até agora):", new Date(until * 1000).toISOString()
    );

    // Trava no servidor: se o ciclo já fechou (hoje passou do fim do período)
    // ou o relatório já foi gerado para este mês, a sincronização é recusada
    // aqui mesmo — não depende só do botão desabilitado no painel.
    if (month.report_locked) {
      return json({ error: `O relatório de ${monthLabel} já foi gerado e os números estão travados. Não é possível sincronizar este mês.` }, 400);
    }
    if (now.getTime() > end.getTime()) {
      return json({ error: `O ciclo de ${monthLabel} (${start.toISOString().slice(0,10)} a ${end.toISOString().slice(0,10)}) já se encerrou. Não é possível sincronizar um mês fechado.` }, 400);
    }

    if (until <= since) {
      return json({ error: `O período de referência do mês ${monthLabel} (${start.toISOString().slice(0,10)} a ${end.toISOString().slice(0,10)}) ainda não começou.` }, 400);
    }

    const result: { instagram: unknown; facebook: unknown; errors: string[] } = {
      instagram: null,
      facebook: null,
      errors: [],
    };

    const channels: string[] | null = Array.isArray(client.social_channels) ? client.social_channels as string[] : null;
    const wantsIg = !channels || channels.includes("instagram");
    const wantsFb = !channels || channels.includes("facebook");

    if (client.ig_business_id && wantsIg) {
      try {
        const igData = await syncInstagram(client.ig_business_id as string, since, until);
        const dbErr = await upsertInsight(supabase, client_id, month.id as string, "instagram", igData);
        if (dbErr) result.errors.push("Instagram (gravação no banco): " + dbErr);
        result.instagram = igData;
        if (igData._warnings && (igData._warnings as unknown as string[]).length) {
          result.errors.push(...(igData._warnings as unknown as string[]));
        }
      } catch (e) {
        console.log("Instagram falhou por completo:", (e as Error).message);
        result.errors.push("Instagram: " + (e as Error).message);
      }
    }

    if (client.fb_page_id && wantsFb) {
      try {
        const fbData = await syncFacebook(client.fb_page_id as string, since, until);
        const dbErr = await upsertInsight(supabase, client_id, month.id as string, "facebook", fbData);
        if (dbErr) result.errors.push("Facebook (gravação no banco): " + dbErr);
        result.facebook = fbData;
        if (fbData._warnings && (fbData._warnings as unknown as string[]).length) {
          result.errors.push(...(fbData._warnings as unknown as string[]));
        }
      } catch (e) {
        console.log("Facebook falhou por completo:", (e as Error).message);
        result.errors.push("Facebook: " + (e as Error).message);
      }
    }

    if (!(client.ig_business_id && wantsIg) && !(client.fb_page_id && wantsFb)) {
      result.errors.push("Nenhum canal Instagram/Facebook ativo e configurado para este cliente.");
    }

    console.log("Resultado final enviado ao painel:", JSON.stringify(result));
    return json(result, 200);
  } catch (e) {
    console.log("Erro geral na função:", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
