// JSN AI Material - API (Netlify Function). Replaces the Flask server in main.py.
// Needs these environment variables (Site configuration -> Environment variables):
//   NETLIFY_DATABASE_URL   set automatically by Netlify DB
//   SESSION_SECRET         long random string used to sign the login cookie
//   ADMIN_PASSWORD         login password   (ADMIN_USER is optional, default "admin")
import crypto from "node:crypto";
import pg from "pg";

pg.types.setTypeParser(20, v => Number(v)); // BIGINT (ts) -> number

const COOKIE = "jsn_session";
const SESSION_SECONDS = 60 * 60 * 12;

/* ---------------------------------------------------------------- db */
let pool;
let ready;
function getPool() {
  if (!pool) {
    const url = process.env.NETLIFY_DATABASE_URL_UNPOOLED || process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
    if (!url) throw new HttpError(500, { error: "Database is not set up. Add Netlify DB to this site." });
    pool = new pg.Pool({ connectionString: url, max: 1 });
  }
  return pool;
}
async function db() {
  const p = getPool();
  ready ??= p.query(`
    CREATE TABLE IF NOT EXISTS txns (
      id           SERIAL PRIMARY KEY,
      type         TEXT NOT NULL CHECK (type IN ('in','out')),
      material     TEXT NOT NULL,
      material_key TEXT NOT NULL,
      qty          DOUBLE PRECISION NOT NULL CHECK (qty > 0),
      by_name      TEXT NOT NULL,
      project      TEXT,
      handover     TEXT,
      remarks      TEXT,
      ts           BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_txns_key ON txns(material_key);
    CREATE INDEX IF NOT EXISTS idx_txns_ts  ON txns(ts);`).catch(e => { ready = undefined; throw e; });
  await ready;
  return p;
}

// Writes run one at a time (advisory lock) so two people can't issue the same stock at once.
async function tx(fn) {
  const c = await (await db()).connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(7331)");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { c.release(); }
}

class HttpError extends Error {
  constructor(status, body) { super(body?.error || "error"); this.status = status; this.body = body; }
}

/* ---------------------------------------------------------------- helpers */
const clean = s => String(s ?? "").split(/\s+/).filter(Boolean).join(" ");
const mkey = s => clean(s).toLowerCase();
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
const bad = errors => new HttpError(400, { errors });

function parseQty(v) { const q = Number(v); return Number.isFinite(q) && q > 0 ? q : null; }
function parseTs(v) { // client-chosen entry time in ms; defaults to now; null if invalid or in the future
  const now = Date.now();
  if (v === undefined || v === null || v === "") return now;
  const ts = Number(v);
  return Number.isInteger(ts) && ts >= 946684800000 && ts <= now + 86400000 ? ts : null;
}

async function balanceOf(c, key) {
  const { rows: [r] } = await c.query(
    `SELECT COALESCE(SUM(CASE WHEN type='in' THEN qty ELSE -qty END),0)::float8 AS b,
            (SELECT material FROM txns WHERE material_key=$1 ORDER BY id LIMIT 1) AS name
     FROM txns WHERE material_key=$1`, [key]);
  return [Math.round(r.b * 1000) / 1000, r.name];
}

async function stockRows(c) {
  const { rows } = await c.query(`
    SELECT * FROM (
      SELECT material_key,
             (SELECT material FROM txns t2 WHERE t2.material_key = t.material_key ORDER BY id LIMIT 1) AS name,
             SUM(CASE WHEN type='in'  THEN qty ELSE 0 END)::float8 AS in_qty,
             SUM(CASE WHEN type='out' THEN qty ELSE 0 END)::float8 AS out_qty,
             MAX(ts) AS last
      FROM txns t GROUP BY material_key) s
    ORDER BY lower(name)`);
  return rows.map(r => ({
    key: r.material_key, name: r.name, in: r.in_qty, out: r.out_qty,
    bal: Math.round((r.in_qty - r.out_qty) * 1000) / 1000, last: r.last,
  }));
}

/* ---------------------------------------------------------------- auth */
const b64 = b => Buffer.from(b).toString("base64url");
function secret() {
  if (!process.env.SESSION_SECRET) throw new HttpError(500, { error: "SESSION_SECRET is not set on the server." });
  return process.env.SESSION_SECRET;
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
  const adminPass = process.env.ADMIN_PASSWORD;
  if (!adminPass) throw new HttpError(500, { error: "ADMIN_PASSWORD is not set on the server." });
  const user = String(d.username ?? "").trim();
  const ok = sameText(user, process.env.ADMIN_USER || "admin") & sameText(d.password ?? "", adminPass);
  if (!ok) {
    await new Promise(r => setTimeout(r, 600)); // slow down password guessing
    throw new HttpError(401, { error: "User name or password is incorrect. Check and try again." });
  }
  return json({ ok: true }, 200, { "Set-Cookie": cookie(makeToken(user), SESSION_SECONDS) });
}

async function apiData() {
  const c = await db();
  const projects = (await c.query(
    "SELECT DISTINCT project FROM txns WHERE project IS NOT NULL AND project<>'' ORDER BY project")).rows.map(r => r.project);
  return { stock: await stockRows(c), projects };
}

async function apiHistory() {
  const { rows } = await (await db()).query(
    `SELECT id,type,material,material_key,qty,by_name AS by,project,handover,ts
     FROM txns ORDER BY ts DESC, id DESC`);
  return { txns: rows };
}

async function apiIn(d) {
  const name = clean(d.material), by = clean(d.by), qty = parseQty(d.qty), ts = parseTs(d.ts);
  const errors = {};
  if (!name) errors.name = "Enter the material name.";
  if (qty === null) errors.qty = "Enter a quantity greater than 0.";
  if (!by) errors.by = "Enter who received the material.";
  if (ts === null) errors.date = "Pick a valid date (not in the future).";
  if (Object.keys(errors).length) throw bad(errors);

  const display = await tx(async c => {
    const key = mkey(name);
    const [, existing] = await balanceOf(c, key);
    const shown = existing || name;
    await c.query("INSERT INTO txns(type,material,material_key,qty,by_name,remarks,ts) VALUES('in',$1,$2,$3,$4,'',$5)",
      [shown, key, qty, by, ts]);
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

  const name = await tx(async c => {
    const [bal, name] = await balanceOf(c, key);
    if (!name || bal <= 0) throw bad({ mat: "This material is not in stock." });
    if (qty > bal + 1e-9) throw bad({ qty: `Only ${bal} available.` });
    await c.query(
      "INSERT INTO txns(type,material,material_key,qty,by_name,project,handover,remarks,ts) VALUES('out',$1,$2,$3,$4,$5,$6,'',$7)",
      [name, key, qty, by, project, handover, ts]);
    return name;
  });
  return { ok: true, message: `Issued ${qty} × ${name} to ${project}` };
}

async function apiEdit(id, d) {
  await tx(async c => {
    const { rows: [row] } = await c.query("SELECT * FROM txns WHERE id=$1", [id]);
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

    const [, existing] = await balanceOf(c, key);
    if (!isIn && !existing) throw bad({ mat: "This material is not in stock." });
    await c.query(
      "UPDATE txns SET material=$1, material_key=$2, qty=$3, by_name=$4, project=$5, handover=$6, ts=$7 WHERE id=$8",
      [existing || name, key, qty, by, isIn ? null : project, isIn ? null : handover, ts, id]);
    for (const k of new Set([row.material_key, key])) {
      const [bal, nm] = await balanceOf(c, k);
      if (bal < -1e-9) throw bad({ qty: `This change would leave ${nm} with ${bal} in stock.` });
    }
  });
  return { ok: true, message: "Entry updated" };
}

async function apiDelete(id) {
  await tx(async c => {
    const { rows: [row] } = await c.query("DELETE FROM txns WHERE id=$1 RETURNING material, material_key", [id]);
    if (!row) throw new HttpError(404, { errors: { qty: "This entry no longer exists." } });
    const [bal] = await balanceOf(c, row.material_key);
    if (bal < -1e-9) throw bad({ qty: `Can't delete: ${row.material} would be left with ${bal} in stock.` });
  });
  return { ok: true, message: "Entry deleted" };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const csvCell = v => { v = String(v ?? ""); return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
async function exportCsv(url) {
  const tz = Number(url.searchParams.get("tz")) || 0; // browser offset, e.g. -330 for IST
  const { rows } = await (await db()).query("SELECT * FROM txns ORDER BY ts DESC, id DESC");
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
