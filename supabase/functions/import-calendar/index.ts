// Edge Function: import-calendar
// Importa do Instagram do cliente tudo o que já foi publicado desde uma data
// e grava no Calendário (calendar_posts) como "publicado".
// Body (admin): { client_id, since: "AAAA-MM-DD" }
import { createClient } from "jsr:@supabase/supabase-js@2";

const GRAPH = "https://graph.facebook.com/v21.0";
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
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

function periodForMonth(label: string, cycleStartDate?: string | null) {
  const [y, m] = label.split("-").map(Number);
  if (cycleStartDate) {
    const [sy, sm, sd] = String(cycleStartDate).slice(0, 10).split("-").map(Number);
    const n = (y * 12 + m) - (sy * 12 + sm);
    return { start: new Date(Date.UTC(sy, sm - 1, sd + 30 * n)), end: new Date(Date.UTC(sy, sm - 1, sd + 30 * n + 29, 23, 59, 59)) };
  }
  let py = y, pm = m - 1;
  if (pm === 0) { pm = 12; py = y - 1; }
  return { start: new Date(Date.UTC(py, pm - 1, 23)), end: new Date(Date.UTC(y, m - 1, 23, 23, 59, 59)) };
}
// data local (Brasília, UTC-3) em AAAA-MM-DD
const brDate = (iso: string) => new Date(Date.parse(iso) - 3 * 3600 * 1000).toISOString().slice(0, 10);
const titleFrom = (caption: string | undefined, fallback: string) => {
  const line = (caption || "").split("\n").map((l) => l.trim()).find((l) => l.length > 0) || "";
  const t = line.replace(/\s+/g, " ").slice(0, 90);
  return t || fallback;
};

async function getJson(url: string) {
  const r = await fetch(url);
  const d = await r.json();
  if (d.error) throw new Error(d.error.message || "Erro na Graph API");
  return d;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    if (!TOKEN) return json({ error: "META_SYSTEM_USER_TOKEN não configurado." }, 500);
    const { client_id, since } = await req.json().catch(() => ({}));
    if (!client_id || !/^\d{4}-\d{2}-\d{2}$/.test(since || "")) return json({ error: "client_id e since (AAAA-MM-DD) são obrigatórios." }, 400);

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const viaSecret = !!CRON_SECRET && (req.headers.get("x-cron-secret") || "") === CRON_SECRET;
    if (!viaSecret) {
      const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
      const { data: u } = await userClient.auth.getUser();
      if (!u?.user) return json({ error: "Não autenticado." }, 401);
      const { data: prof } = await supabase.from("profiles").select("role").eq("id", u.user.id).maybeSingle();
      if (!prof || prof.role !== "admin") return json({ error: "Apenas o admin." }, 403);
    }

    const { data: client } = await supabase.from("clients").select("*").eq("id", client_id).maybeSingle();
    if (!client || !client.ig_business_id) return json({ error: "Cliente sem Instagram configurado." }, 400);
    const sinceMs = Date.parse(since + "T00:00:00-03:00");

    // posts e reels
    const items: { date: string; type: string; title: string; ts: number }[] = [];
    let url: string | undefined = `${GRAPH}/${client.ig_business_id}/media?fields=id,caption,media_product_type,timestamp,permalink&limit=50&access_token=${TOKEN}`;
    for (let page = 0; page < 12 && url; page++) {
      const d = await getJson(url);
      for (const it of d.data || []) {
        const ts = Date.parse(it.timestamp);
        if (isNaN(ts) || ts < sinceMs) continue;
        const reel = it.media_product_type === "REELS";
        items.push({ date: brDate(it.timestamp), type: reel ? "reel" : "post", title: titleFrom(it.caption, reel ? "Reel" : "Post"), ts });
      }
      const times = (d.data || []).map((x: any) => Date.parse(x.timestamp)).filter((t: number) => !isNaN(t));
      if (times.length && Math.min(...times) < sinceMs) break;
      url = d.paging?.next;
    }
    // stories já guardados pela sincronização diária
    const { data: stories } = await supabase.from("published_media").select("published_at").eq("client_id", client_id).eq("platform", "instagram").eq("kind", "story").gte("published_at", new Date(sinceMs).toISOString());
    for (const s of stories || []) items.push({ date: brDate(s.published_at), type: "story", title: "Story", ts: Date.parse(s.published_at) });

    const { data: months } = await supabase.from("deliverable_months").select("id, month_label").eq("client_id", client_id);
    const { data: existing } = await supabase.from("calendar_posts").select("post_date, type, title, channel").eq("client_id", client_id).gte("post_date", since);
    const seen = new Set((existing || []).map((e: any) => `${e.post_date}|${e.channel}|${e.type}|${e.title}`));
    // stories repetidos no mesmo dia viram uma linha por story (contador por dia)
    const rows: Record<string, unknown>[] = [];
    const skipped: string[] = [];
    const storyCount: Record<string, number> = {};
    items.sort((a, b) => a.ts - b.ts);
    for (const it of items) {
      const when = new Date(Date.parse(it.date + "T12:00:00Z"));
      const month = (months || []).find((m: any) => {
        const p = periodForMonth(m.month_label, client.cycle_start_date);
        return when >= p.start && when <= p.end;
      });
      if (!month) { skipped.push(`${it.date} ${it.type}: sem mês cadastrado`); continue; }
      let title = it.title;
      if (it.type === "story") { const k = it.date; storyCount[k] = (storyCount[k] || 0) + 1; title = `Story ${storyCount[k]}`; }
      const key = `${it.date}|instagram|${it.type}|${title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ client_id, deliverable_month_id: month.id, post_date: it.date, channel: "instagram", type: it.type, title, status: "publicado" });
    }
    if (rows.length) {
      const { error } = await supabase.from("calendar_posts").insert(rows);
      if (error) return json({ error: "Gravação: " + error.message }, 500);
    }
    return json({ ok: true, inseridos: rows.length, ignorados: skipped, itens: rows.map((r) => `${r.post_date} ${r.type} — ${r.title}`) });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
