// Sends a region pack's lake outlines to the load-lakes edge function, in batches.
// Runs inside GitHub Actions: it signs each request with the workflow's OIDC token, which the
// function checks, so no database password or service key is stored anywhere.
//   node scripts/load-lakes.mjs mn data/mn/lake_outlines.geojsonl.gz
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';

const [region = 'mn', file = `data/${region}/lake_outlines.geojsonl.gz`] = process.argv.slice(2);
const FN = process.env.LOAD_LAKES_URL || 'https://rjtuvyxiaflqsmrjhscs.supabase.co/functions/v1/load-lakes';
const MAX_BYTES = 1_500_000, MAX_FEATURES = 1500;

async function oidcToken() {
  const { ACTIONS_ID_TOKEN_REQUEST_URL: url, ACTIONS_ID_TOKEN_REQUEST_TOKEN: tok } = process.env;
  if (!url || !tok) throw new Error('No GitHub OIDC token: run this from the "Load lakes" workflow (needs id-token: write).');
  const r = await fetch(`${url}&audience=icebuddy-load-lakes`, { headers: { Authorization: `Bearer ${tok}` } });
  if (!r.ok) throw new Error(`OIDC token request failed: ${r.status}`);
  return (await r.json()).value;
}

let token = await oidcToken(), tokenAt = Date.now();
async function send(features, n) {
  for (let attempt = 1; ; attempt++) {
    if (Date.now() - tokenAt > 4 * 60_000) { token = await oidcToken(); tokenAt = Date.now(); }
    const r = await fetch(FN, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ region, features }) });
    const body = await r.text();
    if (r.ok) { console.log(`batch ${n}: ${body}`); return JSON.parse(body).upserted; }
    if (attempt >= 4 || r.status < 500) throw new Error(`batch ${n} failed: ${r.status} ${body}`);
    console.log(`batch ${n}: ${r.status}, retrying`); await new Promise(res => setTimeout(res, 2000 * attempt));
  }
}

const lines = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
let batch = [], bytes = 0, n = 0, total = 0;
for await (const line of lines) {
  if (!line.trim()) continue;
  if (batch.length && (bytes + line.length > MAX_BYTES || batch.length >= MAX_FEATURES)) {
    total += await send(batch, ++n); batch = []; bytes = 0;
  }
  batch.push(JSON.parse(line)); bytes += line.length;
}
if (batch.length) total += await send(batch, ++n);
console.log(`Loaded ${total} lakes for region "${region}" in ${n} batches.`);
