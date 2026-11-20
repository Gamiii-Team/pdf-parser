// UI/js/app.js — vanilla frontend for the PDF → Structured JSON pipeline.
// Talks to UI/server.mjs (same origin). Zero frontend dependencies.

const $ = (s, r) => (r ?? document).querySelector(s);
const $$ = (s, r) => [...(r ?? document).querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, opts) {
  const r = await fetch(path, opts);
  let j = null;
  try { j = await r.json(); } catch { /* non-JSON */ }
  if (!r.ok) throw new Error(j?.error ?? `${r.status} ${r.statusText}`);
  return j;
}

const state = {
  file: null,          // File object
  demo: null,          // demo id string
  running: false,
  manifest: null,
  report: null,
  runId: null,
};

// ═══════════════ toast ═══════════════
let toastTimer = null;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  requestAnimationFrame(() => el.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.classList.add("hidden"), 220); }, 2200);
}

async function copyText(text, okMsg = "copied") {
  try { await navigator.clipboard.writeText(text); } catch {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch { /* ignore */ }
    ta.remove();
  }
  toast(okMsg);
}

// ═══════════════ status (top bar pill + backend note) ═══════════════
let statusData = null;
async function refreshStatus() {
  const pill = $("#backend-status");
  const note = $("#backend-note");
  try {
    const s = await api("/api/status");
    statusData = s;
    const selEl = $("#backend-select");
    const current = selEl.value;
    // sync option labels with reality
    for (const opt of selEl.options) {
      if (opt.value === s.backend) opt.textContent = opt.value === "groq"
        ? `Groq — ${s.model}`
        : `Modal vLLM — ${s.model}`;
    }
    const isModal = current === "modal";
    if (s.ok) {
      pill.className = "pill pill-ok";
      pill.textContent = isModal ? `Modal vLLM · ${s.model} · ready` : `Groq · ${s.model} · ready`;
    } else {
      pill.className = "pill pill-warn";
      pill.textContent = s.missing.join("; ");
    }
    note.textContent = isModal
      ? (s.ok ? "endpoint configured — model calls go to your vLLM server." : "not configured — set VLLM_ENDPOINT_URL and VLLM_API_TOKEN in .env (see helper below), then restart with npm run ui.")
      : `ready — model: ${s.model} · backend: groq`;
    note.className = "backend-note " + (s.ok ? "ok" : "warn");
    $("#foot-host").textContent = s.host;
  } catch (err) {
    pill.className = "pill pill-bad";
    pill.textContent = `server unreachable: ${err.message}`;
    note.textContent = "Could not reach UI server.";
    note.className = "backend-note warn";
  }
}

// ═══════════════ dropzone & file handling ═══════════════
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function setFile(file) {
  state.file = file ?? null;
  state.demo = null;
  syncFileChip();
  syncDemoButtons();
  syncRunButton();
}

function setDemo(id) {
  state.demo = state.demo === id ? null : id;
  state.file = null;
  syncFileChip();
  syncDemoButtons();
  syncRunButton();
}

function syncFileChip() {
  const chip = $("#file-chip");
  if (state.file) {
    chip.classList.remove("hidden");
    $("#file-chip-name").textContent = state.file.name;
    $("#file-chip-size").textContent = fmtBytes(state.file.size);
  } else {
    chip.classList.add("hidden");
  }
}

function syncDemoButtons() {
  $$(".demo-btn").forEach((b) => b.classList.toggle("active", b.dataset.demo && b.dataset.demo === state.demo));
}

function syncRunButton() {
  $("#run-btn").disabled = state.running || (!state.file && !state.demo);
}

function wireDropzone() {
  const dz = $("#dropzone");
  const input = $("#file-input");
  const openPicker = () => input.click();
  dz.addEventListener("click", openPicker);
  dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPicker(); } });
  input.addEventListener("change", () => setFile(input.files?.[0] ?? null));

  let dragDepth = 0;
  const onDrag = (e, over) => {
    e.preventDefault(); e.stopPropagation();
    if (over) dz.classList.add("dragover"); else if (!dragDepth) dz.classList.remove("dragover");
  };
  dz.addEventListener("dragenter", (e) => { dragDepth++; onDrag(e, true); });
  dz.addEventListener("dragleave", (e) => { dragDepth = Math.max(0, dragDepth - 1); onDrag(e, dragDepth > 0); });
  dz.addEventListener("dragover", (e) => onDrag(e, true));
  dz.addEventListener("drop", (e) => {
    e.preventDefault(); e.stopPropagation();
    dragDepth = 0; dz.classList.remove("dragover");
    const f = e.dataTransfer?.files?.[0];
    if (f) setFile(f);
  });
  $("#file-chip-clear").addEventListener("click", () => setFile(null));
}

// demo buttons (rail + empty-state)
$$(".demo-btn[data-demo]").forEach((b) => b.addEventListener("click", () => setDemo(b.dataset.demo)));

// ═══════════════ loading / result panes ═══════════════
const loadingLines = [
  "reading pages…",
  "classifying headings by font size…",
  "extracting tables & figures…",
  "rendering figure crops…",
  "calling the model…",
  "assembling the section tree…",
];
let loadingTimer = null;

function setRunning(on) {
  state.running = on;
  syncRunButton();
  $("#run-btn-label").textContent = on ? "Running…" : "Analyze →";
  $("#loading").classList.toggle("hidden", !on);
  $("#empty-state").classList.toggle("hidden", on || hasResult());
  $("#result").classList.toggle("hidden", on || !hasResult());
  if (on) {
    let i = 0;
    $("#loading-line").textContent = loadingLines[0];
    clearInterval(loadingTimer);
    loadingTimer = setInterval(() => { $("#loading-line").textContent = loadingLines[++i % loadingLines.length]; }, 1800);
  } else {
    clearInterval(loadingTimer);
  }
}

function hasResult() { return Boolean(state.manifest); }

// ═══════════════ document tree rendering ═══════════════
const CHART_COLORS = ["#f5a623", "#2dd4bf", "#60a5fa", "#a78bfa", "#f87171", "#34d399", "#fbbf24", "#22d3ee"];
const SVG_NS = "http://www.w3.org/2000/svg";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) node.setAttribute(k, String(v));
  return node;
}

function needsReviewNote(parent, why) {
  const d = el("div", "needs-review-line", `needs_review — ${why ?? "unreadable or ambiguous region"}`);
  parent.appendChild(d);
}

function renderTableBlock(block) {
  const fig = el("figure", "table-card" + (block.needs_review ? " needs-review" : ""));
  if (block.caption) fig.appendChild(el("figcaption", null, block.caption));
  const table = el("table");
  const cols = block.content?.columns ?? [];
  const rows = block.content?.rows ?? [];
  if (cols.length) {
    const thead = el("thead");
    const tr = el("tr");
    for (const c of cols) { const th = el("th", null, String(c)); tr.appendChild(th); }
    thead.appendChild(tr);
    table.appendChild(thead);
  }
  const tbody = el("tbody");
  for (const row of rows) {
    const tr = el("tr");
    for (const cell of row ?? []) { const td = el("td", null, String(cell ?? "")); tr.appendChild(td); }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  fig.appendChild(table);
  if (block.needs_review) needsReviewNote(fig, "check the cells by hand");
  return fig;
}

function renderBarChart(values, labels) {
  // simple single-series bar chart, hand-drawn SVG
  const W = 520, H = 190, padL = 40, padB = 26, padT = 10, padR = 8;
  const n = Math.min(values.length, labels.length) || values.length;
  const max = Math.max(...values.slice(0, n).map(Number).filter(Number.isFinite), 1);
  const iw = W - padL - padR, ih = H - padT - padB;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", width: "100%" });
  // gridlines + y labels
  for (let g = 0; g <= 3; g++) {
    const y = padT + (ih * g) / 3;
    const val = Math.round((max * (3 - g)) / 3 * 10) / 10;
    svg.appendChild(svgEl("line", { x1: padL, x2: W - padR, y1: y, y2: y, stroke: "#242a38", "stroke-dasharray": g === 3 ? "" : "2 4" }));
    const t = svgEl("text", { x: padL - 6, y: y + 3.5, "text-anchor": "end", fill: "#5b6072", "font-size": 9 });
    t.textContent = String(val);
    svg.appendChild(t);
  }
  const bw = (iw / Math.max(n, 1)) * 0.62;
  const slot = iw / Math.max(n, 1);
  for (let i = 0; i < n; i++) {
    const v = Number(values[i]) || 0;
    const h = (v / max) * ih;
    const x = padL + i * slot + (slot - bw) / 2;
    const y = padT + ih - h;
    const rect = svgEl("rect", { x, y, width: bw, height: h, rx: 2.5, fill: "#f5a623", opacity: 0.92 });
    const tt = svgEl("title"); tt.textContent = `${labels[i] ?? i}: ${v}`;
    rect.appendChild(tt);
    svg.appendChild(rect);
    const t = svgEl("text", { x: padL + i * slot + slot / 2, y: H - 8, "text-anchor": "middle", fill: "#8b90a5", "font-size": 9 });
    t.textContent = String(labels[i] ?? i);
    svg.appendChild(t);
  }
  return svg;
}

function polarToCartesian(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function renderPieChart(slices) {
  const W = 340, H = 200, cx = 92, cy = 100, r = 72;
  const total = slices.reduce((s, sl) => s + (Number(sl.percent) || 0), 0) || 1;
  let angle = 0;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", width: "100%" });
  slices.forEach((sl, i) => {
    const frac = (Number(sl.percent) || 0) / total;
    const sweep = frac * 360;
    const start = polarToCartesian(cx, cy, r, angle);
    const end = polarToCartesian(cx, cy, r, angle + sweep);
    const large = sweep > 180 ? 1 : 0;
    const d = `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${large} 1 ${end.x} ${end.y} Z`;
    svg.appendChild(svgEl("path", { d, fill: CHART_COLORS[i % CHART_COLORS.length], stroke: "#151820", "stroke-width": 1.5 }));
    angle += sweep;
  });
  // legend
  const lx = cx + r + 16;
  slices.forEach((sl, i) => {
    const y = 40 + i * 22;
    svg.appendChild(svgEl("rect", { x: lx, y: y - 8, width: 12, height: 12, rx: 2, fill: CHART_COLORS[i % CHART_COLORS.length] }));
    const t = svgEl("text", { x: lx + 18, y, fill: "#c9c5b8", "font-size": 11 });
    t.textContent = `${sl.label ?? "?"} — ${sl.percent ?? "?"}%`;
    svg.appendChild(t);
  });
  return svg;
}

function renderChartBlock(block) {
  const fig = el("figure", "chart-card" + (block.needs_review ? " needs-review" : ""));
  const head = el("div", "chart-head");
  head.appendChild(el("span", "chart-type", block.chart_type ?? "other"));
  head.appendChild(el("span", "chart-title", block.title ?? block.caption ?? "Untitled figure"));
  if (block.estimates) head.appendChild(el("span", "chart-est", "estimates †"));
  fig.appendChild(head);
  if (block.caption) fig.appendChild(el("figcaption", null, block.caption));

  const ct = block.chart_type;
  const c = block.content;
  if ((ct === "bar" || ct === "line") && c && Array.isArray(c.x) && Array.isArray(c.series) && c.series[0]?.values) {
    fig.appendChild(renderBarChart(c.series[0].values, c.x));
  } else if (ct === "pie" && c && Array.isArray(c.slices) && c.slices.length) {
    fig.appendChild(renderPieChart(c.slices));
  } else if (c) {
    const pre = el("pre", "code", JSON.stringify(c, null, 2).slice(0, 2000));
    fig.appendChild(pre);
  } else {
    fig.appendChild(el("p", "chart-empty", "no structured data extracted — figure is decorative or unreadable"));
  }
  if (block.description) fig.appendChild(el("p", "chart-desc", block.description));
  if (block.needs_review) needsReviewNote(fig, block.notes ?? null);
  return fig;
}

function renderBlock(block) {
  switch (block.type) {
    case "text": return el("p", "block-text", block.content ?? "");
    case "notes": return el("aside", "notes-card", block.content ?? "");
    case "list": {
      const ul = el("ul", "block-list");
      for (const item of block.items ?? []) ul.appendChild(el("li", null, String(item)));
      return ul;
    }
    case "table": return renderTableBlock(block);
    case "chart": return renderChartBlock(block);
    case "image": return el("div", "image-card", block.caption ?? "image");
    default: return el("p", "block-text", `[${block.type}] ${JSON.stringify(block).slice(0, 300)}`);
  }
}

function renderSections(sections, container, depth = 0) {
  for (const s of sections ?? []) {
    const sec = el("section", `sec depth-${Math.min(depth, 2)}`);
    const head = el("div", "sec-heading");
    head.appendChild(el("span", "lvl", `H${s.level ?? 1}`));
    const h = el(s.level === 1 ? "h1" : s.level === 2 ? "h2" : "h3", null, s.heading ?? "(untitled)");
    head.appendChild(h);
    head.appendChild(el("span", "pg", `p.${(s.pages ?? []).join(",")}`));
    sec.appendChild(head);
    for (const c of s.content ?? []) sec.appendChild(renderBlock(c));
    container.appendChild(sec);
    renderSections(s.subsections, container, depth + 1);
  }
}

function countAllBlocks(sections) {
  let n = 0;
  for (const s of sections ?? []) { n += (s.content ?? []).length + countAllBlocks(s.subsections); }
  return n;
}
function countNeedsReview(sections) {
  let n = 0;
  const walk = (s) => { for (const c of s.content ?? []) if (c.needs_review) n++; for (const sub of s.subsections ?? []) walk(sub); };
  for (const s of sections ?? []) walk(s);
  return n;
}

function setOutput(manifest, report, meta) {
  state.manifest = manifest;
  state.report = report;
  const numBlocks = countAllBlocks(manifest.sections);
  const nr = countNeedsReview(manifest.sections);
  const tokensIn = report?.total_tokens_input ?? meta?.tokens?.input ?? 0;
  const tokensOut = report?.total_tokens_output ?? meta?.tokens?.output ?? 0;
  const dur = ((report?.duration_ms ?? meta?.duration_ms ?? 0) / 1000).toFixed(1);

  // summary band
  const band = $("#summary-band");
  band.innerHTML = "";
  const ok = nr === 0;
  band.appendChild(el("span", "ok-dot", ok ? "●" : "▲"));
  band.appendChild(el("span", "sum-main", `${manifest.subject ?? "document"} — complete`));
  for (const [label, value] of [
    ["pages", manifest.pages], ["blocks", numBlocks], ["sections", countSectionsClient(manifest.sections)],
    ["tokens in", tokensIn], ["tokens out", tokensOut], ["time", `${dur}s`],
  ]) {
    const chip = el("span", "chip");
    chip.innerHTML = `${esc(label)} <b>${esc(String(value))}</b>`;
    band.appendChild(chip);
  }
  if (nr > 0) band.appendChild(el("span", "chip", `needs_review × ${nr}`));

  // pptx-only: visible vs skipped (hidden/empty) slides, and analysis error count
  if (report?.pptx && typeof report.pptx === "object") {
    const { total, visible } = report.pptx;
    const skipped = (total ?? 0) - (visible ?? 0);
    if (skipped > 0) {
      const skipChip = el("span", "chip", `slides ${visible}/${total} — ${skipped} skipped (hidden/empty)`);
      skipChip.setAttribute("title", "Hidden and empty slides are never rendered into the PDF — they are not counted in pages.");
      band.appendChild(skipChip);
    }
  }
  const errLists = report?.errors ?? {};
  const errMsgs = Object.entries(errLists).flatMap(([k, v]) => (Array.isArray(v) ? v.map((m) => `[${k}] ${m}`) : []));
  if (errMsgs.length > 0) {
    const errChip = el("span", "chip chip-warn", `⚠ errors × ${errMsgs.length}`);
    errChip.setAttribute("title", errMsgs.join("\n"));
    band.appendChild(errChip);
  }
  const cov = report?.validation?.text_coverage ?? [];
  if (Array.isArray(cov) && cov.length) {
    const worst = Math.min(...cov.map((c) => Number(c?.coverage) || 0));
    const allOk = cov.every((c) => c?.ok !== false);
    const covChip = el("span", `chip ${allOk ? "chip-ok" : "chip-warn"}`, `coverage <b>${Math.round(worst * 100)}%</b>`);
    covChip.setAttribute("title", cov.map((c) => `page ${c.page}: ${Math.round((Number(c?.coverage) || 0) * 100)}%${c.ok ? "" : " — under-covered (content may be missing — check the VLM notes)"}`).join("\n"));
    band.appendChild(covChip);
  }

  // tabs
  $("#raw-pre").textContent = JSON.stringify(manifest, null, 2);
  $("#report-pre").textContent = JSON.stringify(report ?? {}, null, 2);
  const tree = $("#sections-tree");
  tree.innerHTML = "";
  renderSections(manifest.sections, tree);

  $("#empty-state").classList.add("hidden");
  $("#loading").classList.add("hidden");
  $("#result").classList.remove("hidden");
  activateTab("tree");
}

function countSectionsClient(sections) {
  let n = 0;
  const walk = (s) => { n++; for (const sub of s.subsections ?? []) walk(sub); };
  for (const s of sections ?? []) walk(s);
  return n;
}

function activateTab(name) {
  $$(".tab").forEach((t) => {
    const active = t.dataset.tab === name;
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", active ? "true" : "false");
  });
  for (const id of ["tree", "raw", "report"]) {
    $(`#tab-${id}`).classList.toggle("hidden", id !== name);
  }
}
$$(".tab").forEach((t) => t.addEventListener("click", () => activateTab(t.dataset.tab)));

// downloads + copies
$("#dl-manifest").addEventListener("click", () => downloadJson("manifest.json", state.manifest));
$("#dl-report").addEventListener("click", () => downloadJson("run-report.json", state.report ?? {}));
$("#copy-output").addEventListener("click", () => {
  const active = $(".tab.active")?.dataset.tab;
  const data = active === "report" ? state.report : state.manifest;
  copyText(JSON.stringify(data, null, 2), "output copied to clipboard");
});
$("#copy-env").addEventListener("click", () => copyText($("#env-block").textContent, "env block copied"));

function downloadJson(filename, data) {
  if (!data) return;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = el("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ═══════════════ run pipeline ═══════════════
async function runPipeline() {
  if (state.running) return;
  if (!state.file && !state.demo) return;

  setRunning(true);
  $("#error-drawer").classList.add("hidden");

  const fd = new FormData();
  if (state.demo) fd.append("demo", state.demo);
  if (state.file) fd.append("file", state.file, state.file.name);
  fd.append("modelBackend", $("#backend-select").value);
  fd.append("mode", $("#mode-select").value);
  fd.append("forceVlm", String($("#opt-force-vlm").checked));
  fd.append("figurePass", String($("#opt-figure-pass").checked));
  fd.append("subjectDetect", String($("#opt-subject-detect").checked));
  const subject = $("#subject").value.trim();
  if (subject) fd.append("subject", subject);

  try {
    const data = await api("/api/analyze", { method: "POST", body: fd });
    if (data.mode === "vlm") {
      // vlm mode runs asynchronously — poll the job until it reaches review or fails.
      // No fixed cap: a 25-slide deck at ~2-3s/slide plus retries can legitimately exceed 10 min.
      toast("vlm job accepted — analyzing slides as they arrive…");
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        const { job } = await api(`/api/jobs/${encodeURIComponent(data.jobId)}`);
        const status = job?.status ?? "unknown";
        if (status === "review" || status === "done") break;
        if (status === "failed") throw new Error(job.error ?? "vlm job failed");
        // Surface live progress in the loading pane so the user sees slides as they land.
        const prog = job?.progress ?? null;
        const row = $("#pbarRow");
        if (prog) {
          row.hidden = false;
          clearInterval(loadingTimer); // stop the rotating placeholder text
          const stage = prog.stage ?? status;
          const fill = $("#pbarFill");
          if ((prog.total ?? 0) > 0 && stage === "analyzing") {
            $("#pbar").classList.remove("indeterminate");
            fill.style.width = `${Math.min(100, Math.round((prog.done / prog.total) * 100))}%`;
            $("#loading-line").textContent = `analyzing slides… ${prog.done}/${prog.total}`;
          } else {
            $("#pbar").classList.add("indeterminate");
            fill.style.width = "0%";
            $("#loading-line").textContent = stage === "merging" ? "merging results…" : stage === "converting" ? "converting deck…" : "starting…";
          }
          $("#pbarEta").textContent = prog.etaText ?? "";
        }
      }
      window.location.href = `/review.html?id=${encodeURIComponent(data.jobId)}`;
      return;
    }
    state.runId = data.runId;
    setOutput(data.manifest, data.report, null);
    refreshHistory();
    toast("analysis complete");
  } catch (err) {
    $("#ed-body").textContent = err.message ?? String(err);
    $("#error-drawer").classList.remove("hidden");
    setRunning(false);
    $("#empty-state").classList.toggle("hidden", hasResult());
    $("#result").classList.toggle("hidden", !hasResult());
    return;
  }
  setRunning(false);
}

$("#run-btn").addEventListener("click", runPipeline);
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); runPipeline(); }
});
$("#backend-select").addEventListener("change", refreshStatus);
$("#ed-close").addEventListener("click", () => $("#error-drawer").classList.add("hidden"));
$("#ed-copy").addEventListener("click", () => copyText($("#ed-body").textContent, "error copied"));

// ═══════════════ history ═══════════════
async function refreshHistory() {
  const list = $("#history-list");
  try {
    const { runs } = await api("/api/runs");
    $("#history-count").textContent = String(runs.length);
    list.innerHTML = "";
    if (!runs.length) {
      list.appendChild(el("div", "h-empty", "No runs yet.\nRun the demo and results land here."));
      return;
    }
    for (const run of runs) {
      const item = el("div", "h-item");
      item.setAttribute("role", "button");
      item.tabIndex = 0;
      const name = el("div", "h-name", run.input ?? "input");
      const meta = el("div", "h-meta");
      meta.innerHTML = [
        `<b>${esc(run.backend ?? "?")}</b>`,
        run.pages != null ? `${esc(String(run.pages))} pgs` : "",
        run.tokens ? `<b>${esc(String((run.tokens.input ?? 0) + (run.tokens.output ?? 0)))}</b> tok` : "",
      ].filter(Boolean).join(" · ");
      const row = el("div", "h-row");
      row.appendChild(el("span", "h-time", timeAgo(run.created)));
      const del = el("button", "h-del", "×");
      del.setAttribute("aria-label", `delete run ${run.input ?? run.runId}`);
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete run "${run.input ?? run.runId}"?`)) return;
        try { await api(`/api/runs/${encodeURIComponent(run.runId)}`, { method: "DELETE" }); toast("run deleted"); refreshHistory(); } catch (err) { toast(`delete failed: ${err.message}`); }
      });
      row.appendChild(del);
      item.appendChild(name); item.appendChild(meta); item.appendChild(row);
      const load = async () => {
        try {
          const data = await api(`/api/runs/${encodeURIComponent(run.runId)}`);
          setOutput(data.manifest, data.report, data.meta);
          toast("run loaded");
        } catch (err) { toast(`could not load run: ${err.message}`); }
      };
      item.addEventListener("click", load);
      item.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); load(); } });
      list.appendChild(item);
    }
  } catch (err) {
    list.innerHTML = "";
    list.appendChild(el("div", "h-empty", `history unavailable: ${err.message}`));
  }
}

function timeAgo(ms) {
  if (!ms) return "unknown time";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

// deep link: /?run=test.pdf, ?run=fixtures/scanned.pdf or ?run=fixtures/sample.pptx pre-selects the demo (no auto-run — it spends tokens)
const deepRun = new URLSearchParams(location.search).get("run");
if (deepRun === "test.pdf" || deepRun === "fixtures/scanned.pdf" || deepRun === "fixtures/sample.pptx") {
  setDemo(deepRun);
  toast(`demo armed: ${deepRun} — press Analyze`);
}

// ═══════════════ init ═══════════════
wireDropzone();
syncRunButton();
refreshStatus();
refreshHistory();
setInterval(refreshHistory, 30000);
