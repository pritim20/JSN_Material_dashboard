(function () {
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = n => (Math.round(n * 1000) / 1000).toLocaleString("en-IN");
  const day = ts => new Date(ts).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  const norm = s => String(s).trim().toLowerCase();
  const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base" });

  let outs = []; // Material Out entries; older ones have no company, so the project name stands in
  const companyOf = t => t.company || t.project || "";

  function fillSelect(sel, first, items, keep) {
    sel.innerHTML = `<option value="">${esc(first)}</option>` + items.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join("");
    if (keep && [...sel.options].some(o => o.value === keep)) sel.value = keep;
  }

  function fillCompanies() {
    const seen = new Map();
    for (const t of outs) { const k = norm(companyOf(t)); if (!seen.has(k)) seen.set(k, companyOf(t)); }
    fillSelect($("#repCo"), "Select company", [...seen].sort((a, b) => byName(a[1], b[1])), $("#repCo").value);
  }

  function fillProjects(keepProject) {
    const co = $("#repCo").value, sel = $("#repPr");
    sel.disabled = !co;
    const seen = new Map();
    for (const t of outs) if (norm(companyOf(t)) === co && t.project) { const k = norm(t.project); if (!seen.has(k)) seen.set(k, t.project); }
    fillSelect(sel, co ? "Select project" : "Select a company first",
      co ? [["*", "All projects"], ...[...seen].sort((a, b) => byName(a[1], b[1]))] : [], keepProject);
  }

  function showCard() {
    const co = $("#repCo").value, pr = $("#repPr").value, card = $("#repCard");
    const open = !!(co && pr);
    card.hidden = !open;
    $("#repHint").hidden = open;
    if (!open) { $("#repHint").querySelector("p").textContent = co ? "Now select a project to open its details." : "Select a company, then a project, to see the material provided."; return; }

    const rows = outs.filter(t => norm(companyOf(t)) === co && (pr === "*" || norm(t.project || "") === pr))
      .sort((a, b) => b.ts - a.ts || b.id - a.id);
    const company = $("#repCo").selectedOptions[0].textContent, project = $("#repPr").selectedOptions[0].textContent;
    const mats = new Map();
    for (const t of rows) mats.set(t.material, (mats.get(t.material) || 0) + t.qty);
    const total = rows.reduce((s, t) => s + t.qty, 0);
    const people = [...new Set(rows.map(t => t.handover).filter(Boolean))];

    card.innerHTML = `
      <div><h3>${esc(company)}</h3><div class="sub">Project: ${esc(project)}</div></div>
      <div class="rep-stats">
        <div class="rep-stat"><span>Total quantity</span><b>${fmt(total)}</b></div>
        <div class="rep-stat"><span>Materials</span><b>${mats.size}</b></div>
        <div class="rep-stat"><span>Issues</span><b>${rows.length}</b></div>
        <div class="rep-stat"><span>Last issued</span><b style="font-size:16px">${rows.length ? day(rows[0].ts) : "—"}</b></div>
      </div>
      <div>
        <h4>Material provided</h4>
        <div class="tbl-wrap"><table>
          <thead><tr><th>Material</th><th class="num">Quantity</th></tr></thead>
          <tbody>${[...mats].sort((a, b) => byName(a[0], b[0])).map(([m, q]) => `<tr><td>${esc(m)}</td><td class="num">${fmt(q)}</td></tr>`).join("")}
            <tr><td><b>Total</b></td><td class="num">${fmt(total)}</td></tr></tbody>
        </table></div>
      </div>
      <div>
        <h4>All issues${people.length ? ` · handed over to ${esc(people.join(", "))}` : ""}</h4>
        <div class="tbl-wrap"><table class="wide">
          <thead><tr><th>Date</th><th>Material</th><th class="num">Quantity</th><th>Project</th><th>Out by</th><th>Handed over to</th></tr></thead>
          <tbody>${rows.map(t => `<tr><td>${day(t.ts)}</td><td>${esc(t.material)}</td><td class="num">${fmt(t.qty)}</td><td>${esc(t.project || "—")}</td><td>${esc(t.by)}</td><td>${esc(t.handover || "—")}</td></tr>`).join("")}</tbody>
        </table></div>
      </div>`;
  }

  $("#repCo").addEventListener("change", () => { fillProjects(""); showCard(); });
  $("#repPr").addEventListener("change", showCard);

  async function load() {
    try {
      const res = await fetch("/api/history", { headers: { Accept: "application/json" } });
      if (res.status === 401) { location.href = "/login"; return; }
      outs = (await res.json()).txns.filter(t => t.type === "out" && companyOf(t));
      const prevPr = $("#repPr").value;
      fillCompanies(); fillProjects(prevPr); showCard();
    } catch (e) { /* server unreachable: keep what is shown, retry on the next poll */ }
  }
  load();
  setInterval(() => { if (!document.hidden) load(); }, 15000);
  window.addEventListener("jsn:changed", load); // an entry was just saved from the Material In/Out cards
})();
