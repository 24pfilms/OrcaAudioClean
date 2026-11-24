// OrcaAudioCleanup window: queue list, before/after player, live mix sliders.
"use strict";

const $ = (id) => document.getElementById(id);
const DEFAULT_MIX = { speech: 54, background: 10, music: 10 };
let api = null;              // window.pywebview.api, once ready
let jobs = [];
let lastJSON = "";
let selected = localStorage.getItem("oc-selected") || null;

// ---------- Orca appearance (palette, brightness, saturation, glass) ----------
Orca.mountAppearance($("appearance"));
// The waveform is drawn on a canvas, so repaint it whenever the palette changes.
new MutationObserver(() => drawWave()).observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });

// ---------- resizable divider (width remembered) ----------
(function () {
  const left = $("left"), div = $("divider");
  const saved = +localStorage.getItem("oc-left-width");
  if (saved) left.style.width = saved + "px";
  div.addEventListener("mousedown", (e) => {
    e.preventDefault();
    div.classList.add("dragging");
    const move = (ev) => {
      const w = Math.max(260, Math.min(ev.clientX, window.innerWidth - 420));
      left.style.width = w + "px";
      drawWave();
    };
    const up = () => {
      div.classList.remove("dragging");
      localStorage.setItem("oc-left-width", parseInt(left.style.width, 10));
      removeEventListener("mousemove", move);
      removeEventListener("mouseup", up);
    };
    addEventListener("mousemove", move);
    addEventListener("mouseup", up);
  });
})();

// ---------- drag and drop (the Python side reads the real file paths) ----------
let dragDepth = 0;
addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; document.body.classList.add("dragging"); });
addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging"); } });
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove("dragging");
  setTimeout(refresh, 300);
});

$("add").onclick = () => api && api.pick_files().then(refresh);
$("drop").onclick = () => api && api.pick_files().then(refresh);
$("clear-done").onclick = () => api && api.clear("finished").then(refresh);
$("clear-all").onclick = () => {
  if (!jobs.length) return;
  if (confirm("Remove every file from the list?\nCleaned files you already saved are kept.")) {
    api.clear("all").then(refresh);
  }
};

// ---------- queue list ----------
function fmtTime(s) {
  if (s == null || !isFinite(s)) return "";
  s = Math.max(0, Math.round(s));
  const m = Math.floor(s / 60), r = s % 60;
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(r).padStart(2, "0")}`
                 : `${m}:${String(r).padStart(2, "0")}`;
}
const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const STATUS = { queued: "Waiting", running: "Cleaning", done: "Done", error: "Failed", cancelled: "Stopped" };

function renderList() {
  const list = $("list");
  if (!jobs.length) {
    list.innerHTML = "";
    $("count").textContent = "No files yet";
    return;
  }
  const done = jobs.filter((j) => j.status === "done").length;
  const waiting = jobs.filter((j) => j.status === "queued" || j.status === "running").length;
  $("count").textContent = `${jobs.length} file${jobs.length > 1 ? "s" : ""} · ${done} done` +
    (waiting ? ` · ${waiting} to go` : "");
  list.innerHTML = jobs.map((j) => {
    const pct = Math.round((j.progress || 0) * 100);
    let sub = esc(j.meta || "");
    if (j.status === "running") sub = `${esc(j.label || "")} · ${pct}%` + (j.eta != null ? ` · ${fmtTime(j.eta)} left` : "");
    if (j.status === "done" && j.took) sub += ` · took ${fmtTime(j.took)}`;
    let act = "";
    if (j.status === "running" || j.status === "queued") act = `<button class="act" data-act="cancel">Stop</button>`;
    if (j.status === "error" || j.status === "cancelled") act = `<button class="act" data-act="retry">Try again</button>`;
    return `<div class="item ${j.id === selected ? "sel" : ""}" data-id="${j.id}">
      <div class="row">
        <span class="name" title="${esc(j.input)}">${esc(j.name)}</span>
        <span class="badge ${j.status}">${STATUS[j.status] || j.status}</span>
        ${act}
        <button class="x" data-act="remove" title="Remove from list">✕</button>
      </div>
      <div class="sub">${sub}</div>
      ${j.status === "running" ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ""}
      ${j.status === "error" && j.error ? `<div class="err">${esc(j.error)}</div>` : ""}
    </div>`;
  }).join("");
}

// pointerdown, not click: the list is redrawn while a file is cleaning, and a
// click whose press and release land on different redraws would be lost.
$("list").addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  const item = e.target.closest(".item");
  if (!item) return;
  const id = item.dataset.id, act = e.target.dataset.act;
  if (act === "remove") {
    if (id === selected) closePlayer();
    api.remove(id).then(refresh);
  } else if (act === "cancel") api.cancel(id).then(refresh);
  else if (act === "retry") api.retry(id).then(refresh);
  else selectJob(id);
});

async function refresh() {
  if (!api) return;
  const st = await api.state();
  const json = JSON.stringify(st.jobs);
  if (json === lastJSON) return;
  lastJSON = json;
  jobs = st.jobs;
  renderList();
  const sel = jobs.find((j) => j.id === selected);
  if (selected && !sel) closePlayer();
  else if (sel && sel.status === "done" && !player.job) selectJob(sel.id);
}

// ---------- player ----------
const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
const master = ctx.createGain();
master.connect(ctx.destination);
const player = { job: null, bufs: {}, gains: {}, sources: [], playing: false, startAt: 0,
                 offset: 0, duration: 0, original: false, peaks: null, saved: null, token: 0 };

function closePlayer() {
  stopAudio();
  player.job = null;
  selected = null;
  localStorage.removeItem("oc-selected");
  $("player").hidden = true;
  $("empty").hidden = false;
  $("video").removeAttribute("src");
  $("video").load();
  renderList();
}

async function selectJob(id) {
  const job = jobs.find((j) => j.id === id);
  if (!job) return;
  selected = id;
  localStorage.setItem("oc-selected", id);
  renderList();
  if (job.status !== "done" || !job.stems) {
    stopAudio();
    player.job = null;
    $("player").hidden = true;
    $("empty").hidden = false;
    $("empty").querySelector(".empty-title").textContent = job.name;
    $("empty").querySelector(".empty-text").textContent =
      job.status === "error" ? "This file failed. Use Try again, or remove it."
      : job.status === "cancelled" ? "This file was stopped. Use Try again to clean it."
      : "You can listen and change the mix once this file is finished.";
    return;
  }
  if (player.job && player.job.id === id) return;
  stopAudio();
  const token = ++player.token;
  player.job = job;
  player.offset = 0;
  $("empty").hidden = true;
  $("player").hidden = false;
  $("p-name").textContent = job.name;
  $("p-meta").textContent = [job.meta, job.output ? "Saved as " + job.output : ""].filter(Boolean).join(" · ");
  $("loading").hidden = false;
  $("save-msg").textContent = "";

  const v = $("video");
  $("novideo").hidden = !!job.has_video;
  v.hidden = !job.has_video;
  if (job.has_video) v.src = `/media/${job.id}`; else v.removeAttribute("src");
  v.onerror = () => { v.hidden = true; $("novideo").hidden = false; $("novideo").textContent = "Video preview not available for this format"; };

  player.saved = Object.assign({}, DEFAULT_MIX, job.mix || {});
  setSliders(player.saved);
  $("m-row").classList.toggle("off", !job.music);
  $("m").disabled = !job.music;
  $("m-help").textContent = job.music ? "Music to keep" : "No music found in this file";

  try {
    const names = ["clean", "vocals", "background", "music", "original"];
    const loaded = await Promise.all(names.map(async (n) => {
      const r = await fetch(`/stems/${job.id}/preview_${n}.wav`);
      if (!r.ok) return null;
      return ctx.decodeAudioData(await r.arrayBuffer());
    }));
    if (token !== player.token) return;          // another file was picked meanwhile
    player.bufs = {};
    names.forEach((n, i) => { if (loaded[i]) player.bufs[n] = loaded[i]; });
    if (!player.bufs.clean || !player.bufs.original) throw new Error("previews missing");
    player.duration = player.bufs.clean.duration;
    player.peaks = makePeaks();
    $("loading").hidden = true;
    applyMix();
    drawWave();
    updateTime();
  } catch (err) {
    if (token !== player.token) return;
    $("loading").textContent = "Could not load the previews. Try cleaning this file again.";
  }
}

// slider curves: the same maths as the engine (pipeline.mix_coefficients)
function coeffs(mix) {
  const c = (v) => Math.min(1, Math.max(0, v / 100));
  return { s: 1 - Math.pow(1 - c(mix.speech), 6), b: Math.pow(c(mix.background), 2), m: Math.pow(c(mix.music), 2) };
}
function currentMix() { return { speech: +$("s").value, background: +$("b").value, music: +$("m").value }; }
function setSliders(mix) {
  $("s").value = mix.speech; $("b").value = mix.background; $("m").value = mix.music;
  showValues();
}
function showValues() {
  $("s-val").textContent = $("s").value;
  $("b-val").textContent = $("b").value;
  $("m-val").textContent = $("m").value;
  const changed = player.saved && JSON.stringify(currentMix()) !== JSON.stringify(
    { speech: +player.saved.speech, background: +player.saved.background, music: +player.saved.music });
  $("save").disabled = !changed;
}

function applyMix() {
  if (!player.job) return;
  const k = coeffs(currentMix());
  const target = player.original
    ? { clean: 0, vocals: 0, background: 0, music: 0, original: 1 }
    : { clean: k.s, vocals: 1 - k.s, background: k.b, music: k.m, original: 0 };
  for (const n in player.gains) player.gains[n].gain.setTargetAtTime(target[n] ?? 0, ctx.currentTime, 0.012);
  $("ab").textContent = player.original ? "Original" : "Cleaned";
  $("ab").classList.toggle("orig", player.original);
}

["s", "b", "m"].forEach((id) => $(id).addEventListener("input", () => {
  showValues(); applyMix(); $("save-msg").textContent = "";
}));
$("reset").onclick = () => { setSliders(DEFAULT_MIX); applyMix(); };

// ---------- transport ----------
function position() {
  if (!player.playing) return player.offset;
  return Math.min(player.duration, player.offset + (ctx.currentTime - player.startAt));
}
function stopAudio() {
  for (const s of player.sources) { try { s.onended = null; s.stop(); } catch (e) {} }
  player.sources = [];
  for (const n in player.gains) player.gains[n].disconnect();
  player.gains = {};
  if (player.playing) player.offset = position();
  player.playing = false;
  $("play").textContent = "▶";
  if (!$("video").hidden) $("video").pause();
}
function play(at) {
  stopAudio();
  if (!player.job || !player.bufs.clean) return;
  if (ctx.state === "suspended") ctx.resume();
  if (at >= player.duration - 0.05) at = 0;
  const when = ctx.currentTime + 0.06;
  for (const n in player.bufs) {
    const src = ctx.createBufferSource();
    src.buffer = player.bufs[n];
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(g).connect(master);
    src.start(when, at);
    player.sources.push(src);
    player.gains[n] = g;
  }
  player.sources[0].onended = () => { if (player.playing) { stopAudio(); player.offset = 0; updateTime(); drawWave(); } };
  player.offset = at;
  player.startAt = when;
  player.playing = true;
  applyMix();
  $("play").textContent = "❚❚";
  const v = $("video");
  if (!v.hidden && v.src) { v.currentTime = at; v.play().catch(() => {}); }
}
function seek(t) {
  t = Math.max(0, Math.min(player.duration, t));
  if (player.playing) play(t);
  else { player.offset = t; const v = $("video"); if (!v.hidden && v.src) v.currentTime = t; }
  updateTime(); drawWave();
}
$("play").onclick = () => (player.playing ? stopAudio() : play(player.offset));

function setOriginal(on) {
  if (player.original === on) return;
  player.original = on;
  $("hold").classList.toggle("on", on);
  applyMix();
}
$("hold").addEventListener("pointerdown", (e) => { e.preventDefault(); $("hold").setPointerCapture(e.pointerId); setOriginal(true); });
$("hold").addEventListener("pointerup", () => setOriginal(false));
$("hold").addEventListener("pointercancel", () => setOriginal(false));

addEventListener("keydown", (e) => {
  if (!player.job) return;
  if (e.code === "Space") { e.preventDefault(); if (!e.repeat) $("play").click(); }
  else if (e.code === "KeyO") { e.preventDefault(); setOriginal(true); }
  else if (e.code === "ArrowLeft" && e.target.type !== "range") seek(position() - 5);
  else if (e.code === "ArrowRight" && e.target.type !== "range") seek(position() + 5);
});
addEventListener("keyup", (e) => { if (e.code === "KeyO") setOriginal(false); });
addEventListener("blur", () => setOriginal(false));

function updateTime() {
  $("time").textContent = `${fmtTime(position())} / ${fmtTime(player.duration)}`;
}

// ---------- waveform ----------
function makePeaks() {
  const n = 900, out = { orig: new Float32Array(n), clean: new Float32Array(n) };
  const pairs = [["orig", player.bufs.original], ["clean", player.bufs.clean]];
  for (const [k, buf] of pairs) {
    const d = buf.getChannelData(0), step = Math.max(1, Math.floor(d.length / n));
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let j = i * step, e = Math.min(d.length, j + step); j < e; j += 4) { const a = Math.abs(d[j]); if (a > m) m = a; }
      out[k][i] = m;
    }
  }
  let top = 0;
  for (const k in out) for (const v of out[k]) top = Math.max(top, v);
  for (const k in out) for (let i = 0; i < n; i++) out[k][i] /= top || 1;
  return out;
}
function drawWave() {
  const c = $("wave");
  if (!c || $("player").hidden) return;
  const w = c.clientWidth, h = c.clientHeight, dpr = devicePixelRatio || 1;
  c.width = w * dpr; c.height = h * dpr;
  const g = c.getContext("2d");
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  if (!player.peaks) return;
  const css = getComputedStyle(document.documentElement);
  const n = player.peaks.orig.length, mid = h / 2;
  const draw = (arr, color) => {
    g.fillStyle = color;
    for (let x = 0; x < w; x++) {
      const v = arr[Math.floor((x / w) * n)] * (h / 2 - 4);
      g.fillRect(x, mid - v, 1, Math.max(1, v * 2));
    }
  };
  draw(player.peaks.orig, css.getPropertyValue("--wave-a"));
  draw(player.peaks.clean, css.getPropertyValue("--wave-b"));
  const x = (position() / (player.duration || 1)) * w;
  g.fillStyle = css.getPropertyValue("--text").trim() || "#fff";
  g.fillRect(Math.round(x), 0, 2, h);
}
$("wave").addEventListener("click", (e) => {
  const r = $("wave").getBoundingClientRect();
  seek(((e.clientX - r.left) / r.width) * player.duration);
});
addEventListener("resize", drawWave);

function tick() {
  if (player.playing) {
    updateTime(); drawWave();
    const v = $("video");
    if (!v.hidden && v.src && !v.paused && Math.abs(v.currentTime - position()) > 0.15) v.currentTime = position();
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------- save / open ----------
$("save").onclick = async () => {
  const job = player.job;
  if (!job) return;
  const mix = currentMix();
  $("save").disabled = true;
  $("save-msg").className = "save-msg";
  $("save-msg").textContent = "Saving…";
  const r = await api.save_mix(job.id, mix.speech, mix.background, mix.music);
  if (r.ok) {
    player.saved = mix;
    $("save-msg").className = "save-msg ok";
    $("save-msg").textContent = `Saved: ${r.output}`;
  } else {
    $("save-msg").className = "save-msg bad";
    $("save-msg").textContent = r.error || "Save failed.";
  }
  showValues();
  refresh();
};
$("p-open").onclick = () => player.job && api.open_file(player.job.id);
$("p-folder").onclick = () => player.job && api.reveal(player.job.id);

// Footer link opens in the normal web browser, not inside this window.
$("site").onclick = (e) => { e.preventDefault(); api && api.open_site(); };

// ---------- start ----------
addEventListener("pywebviewready", () => {
  api = window.pywebview.api;
  refresh();
  setInterval(refresh, 500);
});
