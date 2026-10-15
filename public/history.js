(function () {
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = n => (Math.round(n * 1000) / 1000).toLocaleString("en-IN");

  let txns = [], sortBy = "date", typeFilter = "all";

  const dayLabel = ts => new Date(ts).toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
  const groupOf = {
    date: t => dayLabel(t.ts),
    project: t => t.project || "No project",
    material: t => t.material,
  };

  function row(t) {
    const d = new Date(t.ts);
    return `<tr>
      <td>${d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}</td>
      <td>${t.type === "in" ? '<span class="chip in">▼ In</span>' : '<span class="chip out">▲ Out</span>'}</td>
      <td>${esc(t.material)}</td>
      <td class="num" style="color:var(--${t.type === "in" ? "in" : "out"})">${t.type === "in" ? "+" : "−"}${fmt(t.qty)}</td>
      <td>${esc(t.by)}</td>
      <td>${esc(t.company || "—")}</td>
      <td>${esc(t.project || "—")}</td>
      <td>${esc(t.handover || "—")}</td>
      <td><button class="btn btn-ghost" type="button" data-edit="${t.id}" style="padding:6px 12px;font-size:13px">Edit</button></td>
    </tr>`;
  }

  function render() {
    const rows = txns.filter(t => typeFilter === "all" || t.type === typeFilter);
    $("#histEmpty").hidden = rows.length > 0;
    // txns arrive newest first; Map keeps insertion order, so date groups stay newest first
    const groups = new Map();
    for (const t of rows) {
      const g = groupOf[sortBy](t);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(t);
    }
    let keys = [...groups.keys()];
    if (sortBy !== "date") {
      keys.sort((a, b) => (a === "No project") - (b === "No project") || a.localeCompare(b, undefined, { sensitivity: "base" }));
    }
    $("#hist").innerHTML = keys.map(k => {
      const list = groups.get(k);
      return `<tr class="grp"><td colspan="9">${esc(k)}<span>${list.length} ${list.length === 1 ? "entry" : "entries"}</span></td></tr>` + list.map(row).join("");
    }).join("");
  }

  $("#hist").addEventListener("click", e => {
    const b = e.target.closest("[data-edit]");
    const t = b && txns.find(x => x.id === Number(b.dataset.edit));
    if (t) window.JSN.editTxn(t);
  });

  function bind(attr, apply) {
    document.querySelectorAll(`[${attr}]`).forEach(b => b.onclick = () => {
      apply(b.getAttribute(attr));
      document.querySelectorAll(`[${attr}]`).forEach(x => x.setAttribute("aria-pressed", x === b));
      render();
    });
  }
  bind("data-s", v => sortBy = v);
  bind("data-t", v => typeFilter = v);

  async function load() {
    try {
      const res = await fetch("/api/history", { headers: { Accept: "application/json" } });
      if (res.status === 401) { location.href = "/login"; return; }
      txns = (await res.json()).txns;
      render();
    } catch (e) { /* server unreachable: keep what is shown, retry on the next poll */ }
  }
  load();
  setInterval(() => { if (!document.hidden) load(); }, 15000);
  window.addEventListener("jsn:changed", load); // an entry was just saved from the Material In/Out cards
})();
