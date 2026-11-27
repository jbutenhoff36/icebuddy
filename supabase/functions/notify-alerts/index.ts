// Sends "Notify me" phone notifications when a new reading matches someone's alert.
// Called only by the database trigger on readings (it sends a shared secret kept in private.settings).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const APP_URL = "https://icebuddy.onrender.com/";
let cfg: { secret: string } | null = null;

async function setting(k: string) {
  const { data, error } = await db.rpc("private_setting", { k });
  if (error) throw error;
  return data as string;
}
async function config() {
  if (cfg) return cfg;
  const [secret, pub, priv] = await Promise.all([setting("hook_secret"), setting("vapid_public"), setting("vapid_private")]);
  webpush.setVapidDetails("mailto:alerts@icebuddy.onrender.com", pub, priv);
  cfg = { secret };
  return cfg;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const weight = (iso: string) => Math.exp(-(Date.now() - Date.parse(iso)) / 3.6e6 / 96);
function average(rows: { inches: number; observed_at: string }[]) {
  let sw = 0, s = 0;
  for (const r of rows) { const w = weight(r.observed_at); sw += w; s += w * Number(r.inches); }
  return sw ? Math.round((s / sw) * 2) / 2 : null;
}
const meets = (v: number | null, op: string, t: number) => v != null && (op === "gte" ? v >= t : v <= t);
const fmt = (v: number) => (Math.round(v * 2) / 2).toString();

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  const { secret } = await config();
  if (req.headers.get("x-hook-secret") !== secret) return json(401, { error: "unauthorized" });
  const { reading_id } = await req.json().catch(() => ({}));
  if (typeof reading_id !== "string") return json(400, { error: "reading_id required" });

  const { data: r } = await db.from("readings").select("id,lake_id,inches,user_id,observed_at").eq("id", reading_id).single();
  if (!r) return json(404, { error: "no such reading" });
  const [{ data: lake }, { data: recent }, { data: alerts }] = await Promise.all([
    db.from("lakes").select("name").eq("id", r.lake_id).single(),
    db.from("readings").select("id,inches,observed_at").eq("lake_id", r.lake_id).gt("observed_at", new Date(Date.now() - 30 * 864e5).toISOString()),
    db.from("alerts").select("id,user_id,metric,op,inches,last_sent_at").eq("lake_id", r.lake_id).eq("active", true),
  ]);
  const name = lake?.name || "a lake you follow";
  const after = average(recent ?? []);
  const before = average((recent ?? []).filter((x) => x.id !== r.id));
  let sent = 0;
  for (const a of alerts ?? []) {
    if (a.user_id === r.user_id) continue; // don't alert people about their own report
    const t = Number(a.inches);
    let body = "";
    if (a.metric === "any") {
      const cool = a.last_sent_at && Date.now() - Date.parse(a.last_sent_at) < 6 * 3.6e6;
      if (cool || !meets(Number(r.inches), a.op, t)) continue;
      body = `New report on ${name}: ${fmt(Number(r.inches))} in of ice.`;
    } else {
      // only when the average crosses the line, not on every report while it stays there
      if (!meets(after, a.op, t) || meets(before, a.op, t)) continue;
      body = `${name} now averages ${fmt(after!)} in of ice (your alert: ${a.op === "gte" ? "at least" : "at most"} ${fmt(t)} in).`;
    }
    const { data: subs } = await db.from("push_subscriptions").select("endpoint,p256dh,auth").eq("user_id", a.user_id);
    const payload = JSON.stringify({ title: "IceBuddy", body, url: `${APP_URL}?lake=${encodeURIComponent(r.lake_id)}`, tag: `lake-${r.lake_id}` });
    for (const s of subs ?? []) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 6 * 3600 });
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await db.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
        else console.error("push failed", code);
      }
    }
    await db.from("alerts").update({ last_sent_at: new Date().toISOString() }).eq("id", a.id);
  }
  return json(200, { sent });
});
