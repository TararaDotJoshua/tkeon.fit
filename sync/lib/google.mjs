// Read a private Google Sheet as a robot (a Google Cloud service account).
// The Treasurer shares the Sheet with the robot's email as a Viewer; nothing is
// published. No Google library: a signed token (RS256) is swapped for a
// read-only access token, then the Sheets API returns the tab's cells.

import { createSign } from 'node:crypto';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

/** The service account's JSON key (as text) -> { client_email, private_key }. */
export function readKey(json) {
  let k;
  try { k = JSON.parse(json); } catch { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON. Paste the whole key file.'); }
  if (k.type !== 'service_account' || !k.client_email || !k.private_key) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not a service account key.');
  return k;
}

/** A link to the Sheet (ideally to the budget tab, with #gid=) -> { id, gid }. */
export function sheetFromUrl(url) {
  const m = /docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(url || '');
  if (!m) throw new Error('BUDGET_SHEET_URL must be a link to the Google Sheet.');
  const g = /[#&?]gid=(\d+)/.exec(url);
  return { id: m[1], gid: g ? Number(g[1]) : null };
}

export function signedAssertion(key, now = Math.floor(Date.now() / 1000)) {
  const head = b64url({ alg: 'RS256', typ: 'JWT' });
  const claim = b64url({ iss: key.client_email, scope: SCOPE, aud: key.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sig = createSign('RSA-SHA256').update(`${head}.${claim}`).sign(key.private_key).toString('base64url');
  return `${head}.${claim}.${sig}`;
}

// A network blip (DNS, a dropped connection, a timeout) makes fetch throw
// "fetch failed" before Google answers; one such blip failed a run on Nov 25.
// Those, and Google's 429 and 5xx, get two more tries a moment apart. A real
// answer such as 403 (not shared) is returned at once.
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
export async function fetchRetry(fetchImpl, url, opts, { tries = 3, waitMs = 2000 } = {}) {
  for (let n = 1; ; n++) {
    try {
      // A fresh timeout each try: an AbortSignal that has fired stays aborted.
      const res = await fetchImpl(url, { ...opts, signal: AbortSignal.timeout(20000) });
      if (!RETRY_STATUS.has(res.status) || n >= tries) return res;
    } catch (e) {
      if (n >= tries) throw netError(e);
    }
    await new Promise((r) => setTimeout(r, waitMs * n));
  }
}

// "fetch failed" alone says nothing; add the cause's code (e.g. ECONNRESET),
// which never holds the Sheet's link or the key.
function netError(e) {
  const code = e?.cause?.code || e?.cause?.name || e?.name;
  return code && !String(e.message).includes(code) ? new Error(`${e.message} (${code})`) : e;
}

async function getJson(res, what) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = body.error?.message || body.error_description || body.error || res.status;
    if (res.status === 403 || res.status === 404) throw new Error(`${what}: ${why}. Is the Sheet shared with the robot's email as a Viewer, and the Sheets API turned on?`);
    throw new Error(`${what}: ${why}`);
  }
  return body;
}

export async function accessToken(key, fetchImpl = fetch, retry) {
  const res = await fetchRetry(fetchImpl, key.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signedAssertion(key) }).toString(),
  }, retry);
  return (await getJson(res, 'Google sign-in for the robot failed')).access_token;
}

/** Every cell of one tab, as rows of values (numbers stay numbers). */
export async function sheetRows(url, keyJson, fetchImpl = fetch, retry) {
  const key = readKey(keyJson);
  const { id, gid } = sheetFromUrl(url);
  const token = await accessToken(key, fetchImpl, retry);
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const api = `https://sheets.googleapis.com/v4/spreadsheets/${id}`;
  const meta = await getJson(await fetchRetry(fetchImpl, `${api}?fields=sheets.properties(sheetId,title)`, auth, retry), 'Could not open the Sheet');
  const tabs = (meta.sheets || []).map((s) => s.properties);
  const tab = gid == null ? tabs[0] : tabs.find((t) => t.sheetId === gid);
  if (!tab) throw new Error('The tab in BUDGET_SHEET_URL (its #gid=) is not in the Sheet anymore.');
  const range = encodeURIComponent(`'${tab.title.replace(/'/g, "''")}'`);
  const vals = await getJson(await fetchRetry(fetchImpl, `${api}/values/${range}?valueRenderOption=UNFORMATTED_VALUE&majorDimension=ROWS`, auth, retry), 'Could not read the budget tab');
  return vals.values || [];
}
