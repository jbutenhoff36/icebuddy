// Loads region-pack lake outlines into public.lakes.
// Only the jbutenhoff36/icebuddy GitHub Action on main can call it: the caller must send a
// GitHub Actions OIDC token, which is verified here against GitHub's published keys.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5.9.6";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const ISSUER = "https://token.actions.githubusercontent.com";
const AUDIENCE = "icebuddy-load-lakes";
const REPO = "jbutenhoff36/icebuddy";
const jwks = createRemoteJWKSet(new URL(ISSUER + "/.well-known/jwks"));

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER, audience: AUDIENCE });
    if (payload.repository !== REPO || payload.ref !== "refs/heads/main") return json(403, { error: "wrong repository or branch" });
  } catch (_e) {
    return json(401, { error: "invalid token" });
  }
  let body: { region?: string; features?: unknown[] };
  try { body = await req.json(); } catch { return json(400, { error: "bad json" }); }
  const region = body.region;
  if (!region || !/^[a-z]{2,8}$/.test(region) || !Array.isArray(body.features) || body.features.length > 2000)
    return json(400, { error: "need region and up to 2000 features" });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data, error } = await db.rpc("upsert_lakes", { region, features: body.features });
  if (error) return json(500, { error: error.message });
  return json(200, { upserted: data });
});
