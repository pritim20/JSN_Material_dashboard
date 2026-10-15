(function () {
  const LOW = window.LOW_STOCK ?? 5;
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const key = n => String(n).trim().replace(/\s+/g, " ").toLowerCase();
  const fmt = n => (Math.round(n * 1000) / 1000).toLocaleString("en-IN");
  const tints = ["t1", "t2", "t3", "t4", "t5", "t6"];
  const tintOf = k => { let h = 0; for (const c of k) h = (h * 31 + c.charCodeAt(0)) >>> 0; return tints[h % tints.length]; };
  const pad = n => String(n).padStart(2, "0");
  const dateStr = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const todayStr = () => dateStr(Date.now());
  // chosen day + the current time of day, so entries on the same date keep their order
  const tsOf = ds => { const [y, m, d] = ds.split("-").map(Number), n = new Date(); return new Date(y, m - 1, d, n.getHours(), n.getMinutes(), n.getSeconds()).getTime(); };
  const setDate = id => { const el = $(id); el.max = todayStr(); el.value = todayStr(); };
  const initials = n => n.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase();

  let editing = null; // history entry being edited, or null when adding a new one
  let data = { stock: [], txns: [], projects: [], today: { in: 0, out: 0 } };

  /* ---------- server ---------- */
  async function api(path, body, method = "POST") {
    const res = await fetch(path, body ? {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    } : {});
    if (res.status === 401) { location.href = "/login"; throw new Error("auth"); }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error("bad"); e.data = json; throw e; }
    return json;
  }

  async function refresh() {
    try {
      data = await api("/api/data?tz=" + new Date().getTimezoneOffset());
      render();
      window.dispatchEvent(new Event("jsn:changed"));
    } catch (e) {
      /* server unreachable: keep the last data and retry on the next poll */
    }
  }

  const stockMap = () => new Map(data.stock.map(s => [s.key, s]));

  /* ---------- render ---------- */
  function render() {
    const items = data.stock;
    if ($("#stock")) renderStock(items);
    fillInSelect();
    $("#coList").innerHTML = [...new Set((data.report || []).map(c => c.company))].map(c => `<option value="${esc(c)}"></option>`).join("");
    $("#projList").innerHTML = data.projects.map(p => `<option value="${esc(p)}"></option>`).join("");
    if (!$("#mOut").hidden) fillOutSelect(true);
  }

  function renderStock(items) {
    const avail = items.filter(i => i.bal > 0);
    const q = key($("#q").value || "");
    const shown = avail.filter(i => !q || key(i.name).includes(q));
    $("#stockEmpty").hidden = avail.length > 0;
    $("#stockPanel").hidden = !avail.length;
    $("#stock").innerHTML = shown.length ? shown.map(i => `<tr>
        <td>${esc(i.name)}</td>
        <td class="num">${fmt(i.bal)}</td>
      </tr>`).join("") : `<tr><td colspan="2" class="log-empty">No materials match your search.</td></tr>`;
  }

  /* ---------- form helpers ---------- */
  function setErr(form, k, msg) {
    const f = form.querySelector(`.field[data-k="${k}"]`);
    if (!f) return;
    f.classList.toggle("bad", !!msg);
    f.querySelector(".err").textContent = msg || "";
  }
  function clearErrs(form) {
    form.querySelectorAll(".field").forEach(f => { f.classList.remove("bad"); const e = f.querySelector(".err"); if (e) e.textContent = ""; });
  }
  function showErrs(form, errors) { Object.entries(errors || {}).forEach(([k, v]) => setErr(form, k, v)); }

  let lastFocus = null;
  function open(id) {
    lastFocus = document.activeElement;
    const o = $(id); o.hidden = false;
    const first = o.querySelector("input,select"); setTimeout(() => first && first.focus(), 30);
  }
  function close(o) { o.hidden = true; if (lastFocus) lastFocus.focus(); }
  document.querySelectorAll(".overlay").forEach(o => {
    o.addEventListener("click", e => { if (e.target === o || e.target.closest("[data-close]")) close(o); });
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape") document.querySelectorAll(".overlay:not([hidden])").forEach(close); });

  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, 2600);
  }

  async function submit(form, path, body, done) {
    const btn = form.querySelector("[type=submit]"); btn.disabled = true;
    try {
      const r = editing ? await api(`/api/txn/${editing.id}`, body, "PUT") : await api(path, body);
      done(); toast(r.message); await refresh();
    } catch (e) {
      if (e.data && e.data.errors) showErrs(form, e.data.errors);
      else if (e.message !== "auth") toast("Could not save. Check the server is running and try again.");
    } finally { btn.disabled = false; }
  }

  /* ---------- Material In ---------- */
  const NEW = "__new__", IN_HINT = "Select a material, or choose “New material…” to add one.";
  function fillInSelect() {
    const sel = $("#inMat"), prev = sel.value;
    sel.innerHTML = `<option value="">Select material</option>` +
      data.stock.map(i => `<option value="${esc(i.key)}">${esc(i.name)} — ${fmt(i.bal)} in store</option>`).join("") +
      `<option value="${NEW}">＋ New material…</option>`;
    if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
    updInSel();
  }
  function updInSel() {
    const v = $("#inMat").value, m = stockMap().get(v);
    $("#inName").hidden = v !== NEW;
    $("#inHint").textContent = m ? `Existing material · ${fmt(m.bal)} in store now` : v === NEW ? "New material will be added to stock." : IN_HINT;
  }
  function setMode(kind) {
    const label = kind === "in" ? "Material In" : "Material Out";
    $(`#m${kind === "in" ? "In" : "Out"}T`).textContent = (editing ? "Edit " : "") + label;
    $(`#f${kind === "in" ? "In" : "Out"} [type=submit]`).textContent = (editing ? "Update " : "Save ") + label;
    $(`#f${kind === "in" ? "In" : "Out"} [data-del]`).hidden = !editing;
  }
  document.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
    if (!editing || !confirm("Delete this entry? This cannot be undone.")) return;
    const modal = b.closest(".overlay"), form = b.closest("form");
    b.disabled = true;
    try {
      const r = await api(`/api/txn/${editing.id}`, {}, "DELETE");
      editing = null; close(modal); toast(r.message); await refresh();
    } catch (e) {
      if (e.data && e.data.errors) showErrs(form, e.data.errors);
      else if (e.message !== "auth") toast("Could not delete. Check the server is running and try again.");
    } finally { b.disabled = false; }
  });
  const tsFor = id => { const v = $(id).value; return editing && v === dateStr(editing.ts) ? editing.ts : tsOf(v); }; // unchanged date keeps its time
  function openIn() { editing = null; const f = $("#fIn"); f.reset(); clearErrs(f); fillInSelect(); setDate("#inDate"); setMode("in"); open("#mIn"); }
  $("#openIn").onclick = openIn;
  if ($("#emptyIn")) $("#emptyIn").onclick = openIn;
  $("#inMat").addEventListener("change", () => { updInSel(); if ($("#inMat").value === NEW) $("#inName").focus(); });
  $("#fIn").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target; clearErrs(f);
    const sel = $("#inMat").value, picked = stockMap().get(sel);
    const material = picked ? picked.name : sel === NEW ? $("#inName").value.trim() : "", qty = parseFloat($("#inQty").value), by = $("#inBy").value.trim();
    let ok = true;
    if (!material) { setErr(f, "name", sel === NEW ? "Enter the material name." : "Select a material."); ok = false; }
    if (!(qty > 0)) { setErr(f, "qty", "Enter a quantity greater than 0."); ok = false; }
    if (!by) { setErr(f, "by", "Enter who received the material."); ok = false; }
    const date = $("#inDate").value;
    if (!date || date > todayStr()) { setErr(f, "date", "Pick a valid date (not in the future)."); ok = false; }
    if (!ok) return;
    submit(f, "/api/in", { material, qty, by, ts: tsFor("#inDate") }, () => { editing = null; close($("#mIn")); });
  });

  /* ---------- Material Out ---------- */
  function fillOutSelect(keep) {
    const sel = $("#outMat"); const prev = keep ? sel.value : "";
    const avail = data.stock.filter(i => i.bal > 0 || (editing && i.key === editing.material_key));
    sel.innerHTML = `<option value="">${avail.length ? "Select material" : "No material in stock"}</option>` +
      avail.map(i => `<option value="${esc(i.key)}">${esc(i.name)} — ${fmt(i.bal)} available</option>`).join("");
    if (prev && avail.some(i => i.key === prev)) sel.value = prev;
    updAvail();
  }
  // stock this entry may use: what is in store, plus its own quantity when editing an Out of the same material
  const availOf = m => m.bal + (editing && editing.type === "out" && editing.material_key === m.key ? editing.qty : 0);
  function updAvail() {
    const m = stockMap().get($("#outMat").value);
    $("#availBox").hidden = !m;
    if (m) { $("#availQty").textContent = fmt(availOf(m)); $("#outQty").max = availOf(m); }
  }
  $("#outMat").addEventListener("change", updAvail);
  $("#openOut").onclick = () => { editing = null; const f = $("#fOut"); f.reset(); clearErrs(f); fillOutSelect(false); setDate("#outDate"); setMode("out"); open("#mOut"); };
  $("#fOut").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target; clearErrs(f);
    const m = stockMap().get($("#outMat").value);
    const qty = parseFloat($("#outQty").value);
    const by = $("#outBy").value.trim(), company = $("#outCo").value.trim(), project = $("#outProj").value.trim(), handover = $("#outTo").value.trim();
    let ok = true;
    if (!m) { setErr(f, "mat", "Select a material to issue."); ok = false; }
    if (!(qty > 0)) { setErr(f, "qty", "Enter a quantity greater than 0."); ok = false; }
    else if (m && qty > availOf(m) + 1e-9) { setErr(f, "qty", `Only ${fmt(availOf(m))} available.`); ok = false; }
    if (!by) { setErr(f, "by", "Enter who issued the material."); ok = false; }
    if (!company) { setErr(f, "company", "Enter the company name."); ok = false; }
    if (!project) { setErr(f, "project", "Enter the project name."); ok = false; }
    if (!handover) { setErr(f, "handover", "Enter who received it."); ok = false; }
    const date = $("#outDate").value;
    if (!date || date > todayStr()) { setErr(f, "date", "Pick a valid date (not in the future)."); ok = false; }
    if (!ok) return;
    submit(f, "/api/out", { material: m.key, qty, by, company, project, handover, ts: tsFor("#outDate") }, () => { editing = null; close($("#mOut")); });
  });

  /* ---------- edit an existing entry (called from the History page) ---------- */
  function editTxn(t) {
    editing = t;
    if (t.type === "in") {
      const f = $("#fIn"); f.reset(); clearErrs(f); fillInSelect(); setDate("#inDate");
      $("#inMat").value = t.material_key; updInSel();
      $("#inQty").value = t.qty; $("#inBy").value = t.by; $("#inDate").value = dateStr(t.ts);
      setMode("in"); open("#mIn");
    } else {
      const f = $("#fOut"); f.reset(); clearErrs(f); fillOutSelect(false); setDate("#outDate");
      $("#outMat").value = t.material_key; updAvail();
      $("#outQty").value = t.qty; $("#outBy").value = t.by; $("#outCo").value = t.company || t.project || ""; $("#outProj").value = t.project || "";
      $("#outTo").value = t.handover || ""; $("#outDate").value = dateStr(t.ts);
      setMode("out"); open("#mOut");
    }
  }
  window.JSN = { editTxn };

  /* ---------- filters ---------- */
  if ($("#q")) $("#q").addEventListener("input", render);

  /* ---------- start ---------- */
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 15000); // pick up entries made by other users
})();
