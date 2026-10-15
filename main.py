"""
JSN AI Material - Material Inventory Management System
------------------------------------------------------
Run:   python main.py
Open:  http://127.0.0.1:5000
Login: user "admin" and the password you set in JSN_ADMIN_PASS
"""

import csv
import io
import os
import secrets
import sqlite3
import time
from functools import wraps

from flask import (Flask, Response, g, jsonify, redirect, render_template,
                   request, session, url_for)
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("JSN_DB_PATH", os.path.join(BASE_DIR, "inventory.db"))
SECRET_FILE = os.path.join(BASE_DIR, ".secret_key")

APP_NAME = "JSN AI Material"
ADMIN_USER = os.environ.get("JSN_ADMIN_USER", "admin")
_admin_pass = os.environ.get("JSN_ADMIN_PASS")
if not _admin_pass:
    raise SystemExit("Set the login password first, e.g.  JSN_ADMIN_PASS='your-password' python main.py")
ADMIN_PASS_HASH = generate_password_hash(_admin_pass)
LOW_STOCK = float(os.environ.get("JSN_LOW_STOCK", "5"))  # at or below = "Low stock"


def load_secret_key():
    """Keep one secret key across restarts so logins survive a restart."""
    if os.environ.get("JSN_SECRET_KEY"):
        return os.environ["JSN_SECRET_KEY"]
    if os.path.exists(SECRET_FILE):
        with open(SECRET_FILE) as f:
            return f.read().strip()
    key = secrets.token_hex(32)
    with open(SECRET_FILE, "w") as f:
        f.write(key)
    return key


app = Flask(__name__)
app.secret_key = load_secret_key()
app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax")


# ---------------------------------------------------------------- database
def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    con = sqlite3.connect(DB_PATH)
    con.executescript(
        """
        CREATE TABLE IF NOT EXISTS txns (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            type         TEXT    NOT NULL CHECK (type IN ('in','out')),
            material     TEXT    NOT NULL,
            material_key TEXT    NOT NULL,
            qty          REAL    NOT NULL CHECK (qty > 0),
            by_name      TEXT    NOT NULL,
            project      TEXT,
            handover     TEXT,
            remarks      TEXT,
            ts           INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_txns_key ON txns(material_key);
        CREATE INDEX IF NOT EXISTS idx_txns_ts  ON txns(ts);
        """
    )
    con.commit()
    con.close()


def clean(s):
    return " ".join(str(s or "").split())


def mkey(name):
    return clean(name).lower()


def stock_rows(db):
    """Balance per material = total in - total out."""
    rows = db.execute(
        """
        SELECT material_key,
               (SELECT material FROM txns t2 WHERE t2.material_key = t.material_key
                 ORDER BY id LIMIT 1)                                   AS name,
               SUM(CASE WHEN type='in'  THEN qty ELSE 0 END)            AS in_qty,
               SUM(CASE WHEN type='out' THEN qty ELSE 0 END)            AS out_qty,
               MAX(ts)                                                  AS last
        FROM txns t GROUP BY material_key ORDER BY name COLLATE NOCASE
        """
    ).fetchall()
    out = []
    for r in rows:
        bal = round((r["in_qty"] or 0) - (r["out_qty"] or 0), 3)
        out.append({"key": r["material_key"], "name": r["name"], "in": r["in_qty"] or 0,
                    "out": r["out_qty"] or 0, "bal": bal, "last": r["last"]})
    return out


def report_rows(db):
    """Per company (project): every material issued to it with the total quantity."""
    companies = {}
    for r in db.execute("SELECT project, material, material_key, qty FROM txns "
                        "WHERE type='out' AND project IS NOT NULL AND project<>'' ORDER BY id"):
        c = companies.setdefault(mkey(r["project"]), {"company": r["project"], "items": {}})
        it = c["items"].setdefault(r["material_key"], {"name": r["material"], "qty": 0})
        it["qty"] = round(it["qty"] + r["qty"], 3)
    return [{"company": c["company"],
             "items": sorted(c["items"].values(), key=lambda i: i["name"].lower())}
            for c in sorted(companies.values(), key=lambda c: c["company"].lower())]


def balance_of(db, key):
    r = db.execute(
        "SELECT COALESCE(SUM(CASE WHEN type='in' THEN qty ELSE -qty END),0) AS b, "
        "(SELECT material FROM txns WHERE material_key=? ORDER BY id LIMIT 1) AS name "
        "FROM txns WHERE material_key=?", (key, key)).fetchone()
    return round(r["b"], 3), r["name"]


# ---------------------------------------------------------------- auth
def login_required(view):
    @wraps(view)
    def wrapped(*a, **kw):
        if not session.get("user"):
            if request.path.startswith("/api/"):
                return jsonify({"error": "Your session has ended. Sign in again."}), 401
            return redirect(url_for("login"))
        return view(*a, **kw)
    return wrapped


@app.route("/login", methods=["GET", "POST"])
def login():
    error = None
    if request.method == "POST":
        user = request.form.get("username", "").strip()
        pw = request.form.get("password", "")
        if user == ADMIN_USER and check_password_hash(ADMIN_PASS_HASH, pw):
            session.clear()
            session["user"] = user
            return redirect(url_for("dashboard"))
        error = "User name or password is incorrect. Check and try again."
    return render_template("login.html", app_name=APP_NAME, error=error)


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


# ---------------------------------------------------------------- pages
@app.route("/")
@login_required
def dashboard():
    return render_template("dashboard.html", app_name=APP_NAME, page="stock",
                           user=session["user"], low_stock=LOW_STOCK)


@app.route("/history")
@login_required
def history():
    return render_template("history.html", app_name=APP_NAME, page="history",
                           user=session["user"], low_stock=LOW_STOCK)


@app.route("/report")
@login_required
def report():
    return render_template("report.html", app_name=APP_NAME, page="report",
                           user=session["user"], low_stock=LOW_STOCK)


# ---------------------------------------------------------------- API
@app.get("/api/history")
@login_required
def api_history():
    rows = get_db().execute(
        "SELECT id,type,material,material_key,qty,by_name AS by,project,handover,ts "
        "FROM txns ORDER BY ts DESC, id DESC")
    return jsonify({"txns": [dict(r) for r in rows]})


@app.get("/api/data")
@login_required
def api_data():
    db = get_db()
    tz_offset_min = int(request.args.get("tz", 0) or 0)  # browser offset, e.g. -330 for IST
    now_local = time.time() - tz_offset_min * 60
    start_today_ms = int((now_local - now_local % 86400 + tz_offset_min * 60) * 1000)

    today = db.execute(
        "SELECT COALESCE(SUM(CASE WHEN type='in' THEN qty END),0) AS i, "
        "COALESCE(SUM(CASE WHEN type='out' THEN qty END),0) AS o FROM txns WHERE ts >= ?",
        (start_today_ms,)).fetchone()
    txns = [dict(r) for r in db.execute(
        "SELECT id,type,material,qty,by_name AS by,project,handover,remarks,ts "
        "FROM txns ORDER BY ts DESC, id DESC LIMIT 200")]
    projects = [r[0] for r in db.execute(
        "SELECT DISTINCT project FROM txns WHERE project IS NOT NULL AND project<>'' "
        "ORDER BY project COLLATE NOCASE")]
    return jsonify({"stock": stock_rows(db), "report": report_rows(db), "txns": txns, "projects": projects,
                    "today": {"in": today["i"], "out": today["o"]}, "low": LOW_STOCK})


def parse_ts(v):
    """Client-chosen entry time in ms; defaults to now. None if invalid or in the future."""
    now = int(time.time() * 1000)
    if v in (None, ""):
        return now
    try:
        ts = int(v)
    except (TypeError, ValueError):
        return None
    return ts if 946684800000 <= ts <= now + 86400000 else None  # year 2000 .. +1 day (timezones)


def parse_qty(v):
    try:
        q = float(v)
        return q if q > 0 else None
    except (TypeError, ValueError):
        return None


@app.post("/api/in")
@login_required
def api_in():
    d = request.get_json(silent=True) or {}
    name, by = clean(d.get("material")), clean(d.get("by"))
    qty = parse_qty(d.get("qty"))
    errors = {}
    if not name:
        errors["name"] = "Enter the material name."
    if qty is None:
        errors["qty"] = "Enter a quantity greater than 0."
    if not by:
        errors["by"] = "Enter who received the material."
    ts = parse_ts(d.get("ts"))
    if ts is None:
        errors["date"] = "Pick a valid date (not in the future)."
    if errors:
        return jsonify({"errors": errors}), 400

    db = get_db()
    key = mkey(name)
    _, existing = balance_of(db, key)
    display = existing or name
    db.execute(
        "INSERT INTO txns(type,material,material_key,qty,by_name,remarks,ts) VALUES('in',?,?,?,?,?,?)",
        (display, key, qty, by, clean(d.get("remarks")), ts))
    return jsonify({"ok": True, "message": f"Added {qty:g} × {display} to stock"})


@app.post("/api/out")
@login_required
def api_out():
    d = request.get_json(silent=True) or {}
    key = mkey(d.get("material"))
    qty = parse_qty(d.get("qty"))
    by, project, handover = clean(d.get("by")), clean(d.get("project")), clean(d.get("handover"))
    errors = {}
    if not key:
        errors["mat"] = "Select a material to issue."
    if qty is None:
        errors["qty"] = "Enter a quantity greater than 0."
    if not by:
        errors["by"] = "Enter who issued the material."
    if not project:
        errors["project"] = "Enter the project name."
    if not handover:
        errors["handover"] = "Enter who received it."
    ts = parse_ts(d.get("ts"))
    if ts is None:
        errors["date"] = "Pick a valid date (not in the future)."
    if errors:
        return jsonify({"errors": errors}), 400

    db = get_db()
    db.execute("BEGIN IMMEDIATE")  # lock so two people can't issue the same stock at once
    try:
        bal, name = balance_of(db, key)
        if not name or bal <= 0:
            db.execute("ROLLBACK")
            return jsonify({"errors": {"mat": "This material is not in stock."}}), 400
        if qty > bal + 1e-9:
            db.execute("ROLLBACK")
            return jsonify({"errors": {"qty": f"Only {bal:g} available."}}), 400
        db.execute(
            "INSERT INTO txns(type,material,material_key,qty,by_name,project,handover,remarks,ts) "
            "VALUES('out',?,?,?,?,?,?,?,?)",
            (name, key, qty, by, project, handover, clean(d.get("remarks")), ts))
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        raise
    return jsonify({"ok": True, "message": f"Issued {qty:g} × {name} to {project}"})


@app.put("/api/txn/<int:tid>")
@login_required
def api_txn_edit(tid):
    """Edit an existing Material In / Out entry. Stock may never go negative afterwards."""
    d = request.get_json(silent=True) or {}
    db = get_db()
    row = db.execute("SELECT * FROM txns WHERE id=?", (tid,)).fetchone()
    if row is None:
        return jsonify({"errors": {"qty": "This entry no longer exists."}}), 404
    is_in = row["type"] == "in"

    qty, by, ts = parse_qty(d.get("qty")), clean(d.get("by")), parse_ts(d.get("ts"))
    project, handover = clean(d.get("project")), clean(d.get("handover"))
    name = clean(d.get("material")) if is_in else ""
    key = mkey(name) if is_in else mkey(d.get("material"))
    errors = {}
    if not key:
        errors["name" if is_in else "mat"] = "Enter the material name." if is_in else "Select a material to issue."
    if qty is None:
        errors["qty"] = "Enter a quantity greater than 0."
    if not by:
        errors["by"] = "Enter who received the material." if is_in else "Enter who issued the material."
    if ts is None:
        errors["date"] = "Pick a valid date (not in the future)."
    if not is_in:
        if not project:
            errors["project"] = "Enter the project name."
        if not handover:
            errors["handover"] = "Enter who received it."
    if errors:
        return jsonify({"errors": errors}), 400

    db.execute("BEGIN IMMEDIATE")
    try:
        _, existing = balance_of(db, key)
        if not is_in and not existing:
            db.execute("ROLLBACK")
            return jsonify({"errors": {"mat": "This material is not in stock."}}), 400
        display = existing or name
        db.execute(
            "UPDATE txns SET material=?, material_key=?, qty=?, by_name=?, project=?, handover=?, ts=? WHERE id=?",
            (display, key, qty, by, None if is_in else project, None if is_in else handover, ts, tid))
        for k in {row["material_key"], key}:
            bal, nm = balance_of(db, k)
            if bal < -1e-9:
                db.execute("ROLLBACK")
                return jsonify({"errors": {"qty": f"This change would leave {nm} with {bal:g} in stock."}}), 400
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        raise
    return jsonify({"ok": True, "message": "Entry updated"})


@app.delete("/api/txn/<int:tid>")
@login_required
def api_txn_delete(tid):
    """Delete a Material In / Out entry. Removing an In is refused if it would make stock negative."""
    db = get_db()
    db.execute("BEGIN IMMEDIATE")
    try:
        row = db.execute("SELECT * FROM txns WHERE id=?", (tid,)).fetchone()
        if row is None:
            db.execute("ROLLBACK")
            return jsonify({"errors": {"qty": "This entry no longer exists."}}), 404
        db.execute("DELETE FROM txns WHERE id=?", (tid,))
        bal, _ = balance_of(db, row["material_key"])
        if bal < -1e-9:
            db.execute("ROLLBACK")
            return jsonify({"errors": {"qty": f"Can't delete: {row['material']} would be left with {bal:g} in stock."}}), 400
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        raise
    return jsonify({"ok": True, "message": "Entry deleted"})


@app.get("/export.csv")
@login_required
def export_csv():
    db = get_db()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Date", "Type", "Material", "Quantity", "By", "Handed over to", "Project"])
    for r in db.execute("SELECT * FROM txns ORDER BY ts DESC, id DESC"):  # newest first, same as History
        t = time.localtime(r["ts"] / 1000)
        w.writerow([time.strftime("%d %b %Y", t),
                    "Material In" if r["type"] == "in" else "Material Out",
                    r["material"], f'{r["qty"]:g}', r["by_name"],
                    r["handover"] or "-", r["project"] or "-"])
    # BOM so Excel opens the file as UTF-8 and shows it in tidy columns
    return Response("\ufeff" + buf.getvalue(), mimetype="text/csv", content_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": "attachment; filename=jsn-material-history.csv"})


init_db()

if __name__ == "__main__":
    host = os.environ.get("JSN_HOST", "127.0.0.1")
    port = int(os.environ.get("JSN_PORT", "5000"))
    print(f"\n  {APP_NAME} running at http://{host}:{port}\n  Login: {ADMIN_USER}\n")
    app.run(host=host, port=port, debug=False)
