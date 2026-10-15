// JSN AI Material - API (Netlify Function). Replaces the Flask server in main.py.
// Data is kept in Netlify Blobs (Netlify's built-in storage) - no database to set up.
// Needs these environment variables (Site configuration -> Environment variables):
//   SESSION_SECRET   long random string used to sign the login cookie
//   ADMIN_PASSWORD   login password   (ADMIN_USER is optional, default "admin")
import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";

// Netlify.env is the documented way to read variables in functions; process.env is the fallback (local runs).
const env = name => globalThis.Netlify?.env?.get(name) ?? process.env[name];

const COOKIE = "jsn_session";
const SESSION_SECONDS = 60 * 60 * 12;

class HttpError extends Error {
  constructor(status, body) { super(body?.error || "error"); this.status = status; this.body = body; }
}

/* ---------------------------------------------------------------- storage
 * All entries live in one JSON document: { nextId, txns: [...] }.
 * Every write is conditional on the document's ETag, so if two people save at the same moment
 * one of them re-reads and re-checks the stock instead of overwriting the other. */
const KEY = "inventory";
let store;
const blobs = () => globalThis.__jsnTestStore ?? (store ??= getStore({ name: "jsn-material", consistency: "strong" }));

async function load() {
  const r = await blobs().getWithMetadata(KEY, { type: "json", consistency: "strong" });
  return r ? { doc: r.data, etag: r.etag } : { doc: { nextId: 1, txns: [] }, etag: null };
}

// Run fn(doc) on the current data; fn may change doc (and throw HttpError to refuse). Retries on a conflicting write.
async function mutate(fn) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const { doc, etag } = await load();
    const result = fn(doc);
    const w = await blobs().setJSON(KEY, doc, etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
    if (w.modified) return result;
  }
  throw new HttpError(503, { error: "Busy - another save was in progress. Try again." });
}

/* ---------------------------------------------------------------- helpers */
const clean = s => String(s ?? "").split(/\s+/).filter(Boolean).join(" ");
const mkey = s => clean(s).toLowerCase();
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
const bad = errors => new HttpError(400, { errors });
const r3 = n => Math.round(n * 1000) / 1000;

function parseQty(v) { const q = Number(v); return Number.isFinite(q) && q > 0 ? q : null; }
function parseTs(v) { // client-chosen entry time in ms; defaults to now; null if invalid or in the future
  const now = Date.now();
  if (v === undefined || v === null || v === "") return now;
  const ts = Number(v);
  return Number.isInteger(ts) && ts >= 946684800000 && ts <= now + 86400000 ? ts : null;
}

// [balance, display name] for one material; the name is the first entry's spelling
function balanceOf(txns, key) {
  let b = 0, name = null;
  for (const t of txns) {
    if (t.material_key !== key) continue;
    b += t.type === "in" ? t.qty : -t.qty;
    if (name === null) name = t.material; // txns are kept in id order
  }
  return [r3(b), name];
}

function stockRows(txns) {
  const m = new Map();
  for (const t of txns) {
    let r = m.get(t.material_key);
    if (!r) m.set(t.material_key, r = { key: t.material_key, name: t.material, in: 0, out: 0, last: 0 });
    r[t.type] += t.qty;
    r.last = Math.max(r.last, t.ts);
  }
  return [...m.values()].map(r => ({ ...r, bal: r3(r.in - r.out) }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

const byNewest = (a, b) => b.ts - a.ts || b.id - a.id;

/* ---------------------------------------------------------------- auth */
const b64 = b => Buffer.from(b).toString("base64url");
function secret() {
  if (!env("SESSION_SECRET")) throw new HttpError(500, { error: "SESSION_SECRET is not set on the server." });
  return env("SESSION_SECRET");
}
const sign = p => crypto.createHmac("sha256", secret()).update(p).digest("base64url");
function makeToken(user) {
  const p = b64(JSON.stringify({ u: user, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS }));
  return `${p}.${sign(p)}`;
}
function sessionUser(req) {
  const m = (req.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [p, sig] = m[1].split(".");
  if (!p || !sig) return null;
  const want = Buffer.from(sign(p)), got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try {
    const { u, exp } = JSON.parse(Buffer.from(p, "base64url").toString());
    return exp > Date.now() / 1000 ? u : null;
  } catch { return null; }
}
const sameText = (a, b) => {
  const h = s => crypto.createHash("sha256").update(String(s)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
};
const cookie = (value, maxAge) =>
  `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

/* ---------------------------------------------------------------- handlers */
async function login(req) {
  const d = await req.json().catch(() => ({}));
  const adminPass = env("ADMIN_PASSWORD");
  if (!adminPass) throw new HttpError(500, { error: "ADMIN_PASSWORD is not set on the server." });
  const user = String(d.username ?? "").trim();
  const ok = sameText(user, env("ADMIN_USER") || "admin") & sameText(d.password ?? "", adminPass);
  if (!ok) {
    await new Promise(r => setTimeout(r, 600)); // slow down password guessing
    throw new HttpError(401, { error: "User name or password is incorrect. Check and try again." });
  }
  return json({ ok: true }, 200, { "Set-Cookie": cookie(makeToken(user), SESSION_SECONDS) });
}

async function apiData() {
  const { doc } = await load();
  const projects = [...new Set(doc.txns.map(t => t.project).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return { stock: stockRows(doc.txns), projects };
}

async function apiHistory() {
  const { doc } = await load();
  return { txns: [...doc.txns].sort(byNewest).map(({ by_name, remarks, ...t }) => ({ ...t, by: by_name })) };
}

const addTxn = (doc, t) => { doc.txns.push({ id: doc.nextId++, remarks: "", project: null, handover: null, ...t }); };

async function apiIn(d) {
  const name = clean(d.material), by = clean(d.by), qty = parseQty(d.qty), ts = parseTs(d.ts);
  const errors = {};
  if (!name) errors.name = "Enter the material name.";
  if (qty === null) errors.qty = "Enter a quantity greater than 0.";
  if (!by) errors.by = "Enter who received the material.";
  if (ts === null) errors.date = "Pick a valid date (not in the future).";
  if (Object.keys(errors).length) throw bad(errors);

  const display = await mutate(doc => {
    const key = mkey(name);
    const shown = balanceOf(doc.txns, key)[1] || name;
    addTxn(doc, { type: "in", material: shown, material_key: key, qty, by_name: by, ts });
    return shown;
  });
  return { ok: true, message: `Added ${qty} × ${display} to stock` };
}

async function apiOut(d) {
  const key = mkey(d.material), qty = parseQty(d.qty), by = clean(d.by);
  const project = clean(d.project), handover = clean(d.handover), ts = parseTs(d.ts);
  const errors = {};
  if (!key) errors.mat = "Select a material to issue.";
  if (qty === null) errors.qty = "Enter a quantity greater than 0.";
  if (!by) errors.by = "Enter who issued the material.";
  if (!project) errors.project = "Enter the project name.";
  if (!handover) errors.handover = "Enter who received it.";
  if (ts === null) errors.date = "Pick a valid date (not in the future).";
  if (Object.keys(errors).length) throw bad(errors);

  const name = await mutate(doc => {
    const [bal, name] = balanceOf(doc.txns, key);
    if (!name || bal <= 0) throw bad({ mat: "This material is not in stock." });
    if (qty > bal + 1e-9) throw bad({ qty: `Only ${bal} available.` });
    addTxn(doc, { type: "out", material: name, material_key: key, qty, by_name: by, project, handover, ts });
    return name;
  });
  return { ok: true, message: `Issued ${qty} × ${name} to ${project}` };
}

async function apiEdit(id, d) {
  await mutate(doc => {
    const row = doc.txns.find(t => t.id === id);
    if (!row) throw new HttpError(404, { errors: { qty: "This entry no longer exists." } });
    const isIn = row.type === "in";
    const qty = parseQty(d.qty), by = clean(d.by), ts = parseTs(d.ts);
    const project = clean(d.project), handover = clean(d.handover);
    const name = isIn ? clean(d.material) : "";
    const key = mkey(d.material);
    const errors = {};
    if (!key) errors[isIn ? "name" : "mat"] = isIn ? "Enter the material name." : "Select a material to issue.";
    if (qty === null) errors.qty = "Enter a quantity greater than 0.";
    if (!by) errors.by = isIn ? "Enter who received the material." : "Enter who issued the material.";
    if (ts === null) errors.date = "Pick a valid date (not in the future).";
    if (!isIn && !project) errors.project = "Enter the project name.";
    if (!isIn && !handover) errors.handover = "Enter who received it.";
    if (Object.keys(errors).length) throw bad(errors);

    const oldKey = row.material_key;
    const existing = balanceOf(doc.txns, key)[1];
    if (!isIn && !existing) throw bad({ mat: "This material is not in stock." });
    Object.assign(row, { material: existing || name, material_key: key, qty, by_name: by,
      project: isIn ? null : project, handover: isIn ? null : handover, ts });
    for (const k of new Set([oldKey, key])) {
      const [bal, nm] = balanceOf(doc.txns, k);
      if (bal < -1e-9) throw bad({ qty: `This change would leave ${nm} with ${bal} in stock.` });
    }
  });
  return { ok: true, message: "Entry updated" };
}

async function apiDelete(id) {
  await mutate(doc => {
    const i = doc.txns.findIndex(t => t.id === id);
    if (i < 0) throw new HttpError(404, { errors: { qty: "This entry no longer exists." } });
    const [row] = doc.txns.splice(i, 1);
    const [bal] = balanceOf(doc.txns, row.material_key);
    if (bal < -1e-9) throw bad({ qty: `Can't delete: ${row.material} would be left with ${bal} in stock.` });
  });
  return { ok: true, message: "Entry deleted" };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const csvCell = v => { v = String(v ?? ""); return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
async function exportCsv(url) {
  const tz = Number(url.searchParams.get("tz")) || 0; // browser offset, e.g. -330 for IST
  const { doc } = await load();
  const rows = [...doc.txns].sort(byNewest);
  const lines = [["Date", "Type", "Material", "Quantity", "By", "Project", "Handed over to"]];
  for (const r of rows) {
    const d = new Date(r.ts - tz * 60000); // shift, then read with UTC getters = viewer's local date
    lines.push([`${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
      r.type === "in" ? "Material In" : "Material Out", r.material, r.qty, r.by_name, r.project || "-", r.handover || "-"]);
  }
  return new Response("﻿" + lines.map(l => l.map(csvCell).join(",")).join("\r\n") + "\r\n", {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=jsn-material-history.csv", "Cache-Control": "no-store" },
  });
}

/* ---------------------------------------------------------------- router */
export default async (req) => {
  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "");
    const m = req.method;

    if (path === "/api/health" && m === "GET") // setup check: says only whether each setting exists, never its value
      return json({ ADMIN_PASSWORD: !!env("ADMIN_PASSWORD"), SESSION_SECRET: !!env("SESSION_SECRET"), ADMIN_USER: !!env("ADMIN_USER"),
                    storage: await load().then(() => true, () => false) });
    if (path === "/api/login" && m === "POST") return await login(req);
    if (path === "/logout") return new Response(null, { status: 302, headers: { Location: "/login", "Set-Cookie": cookie("", 0) } });

    const user = sessionUser(req);
    if (!user) return json({ error: "Your session has ended. Sign in again." }, 401);

    if (path === "/export.csv" && m === "GET") return await exportCsv(url);
    if (path === "/api/data" && m === "GET") return json({ ...(await apiData()), user });
    if (path === "/api/history" && m === "GET") return json(await apiHistory());

    const body = ["POST", "PUT"].includes(m) ? await req.json().catch(() => ({})) : {};
    if (path === "/api/in" && m === "POST") return json(await apiIn(body));
    if (path === "/api/out" && m === "POST") return json(await apiOut(body));
    const t = path.match(/^\/api\/txn\/(\d+)$/);
    if (t && m === "PUT") return json(await apiEdit(Number(t[1]), body));
    if (t && m === "DELETE") return json(await apiDelete(Number(t[1])));

    return json({ error: "Not found" }, 404);
  } catch (e) {
    if (e instanceof HttpError) return json(e.body, e.status);
    console.error(e);
    return json({ error: "Server error. Try again." }, 500);
  }
};

export const config = { path: ["/api/*", "/logout", "/export.csv"] };
