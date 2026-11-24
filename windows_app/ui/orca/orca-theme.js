/* Orca theme engine — vanilla JS port of Orca Master Theming v1.0.0
   canonical/orca/orca-theme.ts (palettes, persistence, brightness, saturation, glass).
   Attention-override behaviour is omitted (not needed in this app). */
(function () {
  const THEMES = {
    twilight: { wp: ["#0f0a1a","#1e1145","#4a1a6b","#8b2a5e","#c44b3f","#e87d4a","#f4a55a","#fcd49a"], accent: "#c4b5fd", accentBright: "#a78bfa", glassTint: "22,16,36" },
    ocean:    { wp: ["#040d1a","#0a1e3d","#0c3555","#1a6b8a","#2ca5a5","#45c4b0","#6ee7c8","#a7f3d0"], accent: "#67e8f9", accentBright: "#22d3ee", glassTint: "8,18,32" },
    ember:    { wp: ["#1a0800","#3b1106","#6b2410","#9a3412","#c2410c","#ea580c","#f59e0b","#fcd34d"], accent: "#fbbf24", accentBright: "#f59e0b", glassTint: "30,14,8" },
    scarlet:  { wp: ["#0a0605","#160b09","#2b0c08","#4b110c","#7f1d1d","#dc2626","#ef4444","#ff7a6b"], accent: "#ef4444", accentBright: "#ff7a6b", glassTint: "22,12,10" },
    forest:   { wp: ["#020f05","#052e16","#0a4a25","#15803d","#22994e","#34d399","#6ee7a8","#bbf7d0"], accent: "#86efac", accentBright: "#34d399", glassTint: "8,22,14" },
    arctic:   { wp: ["#050a18","#0c1929","#152e52","#1e40af","#3b82f6","#60a5fa","#93c5fd","#bfdbfe"], accent: "#93c5fd", accentBright: "#60a5fa", glassTint: "10,14,30" },
    solar:    { wp: ["#1a0f00","#422006","#6b3410","#92400e","#b45309","#ca8a04","#eab308","#fef08a"], accent: "#fde047", accentBright: "#eab308", glassTint: "30,22,8" },
    sakura:   { wp: ["#1a0510","#3b0626","#6b1048","#9d174d","#be185d","#db2777","#ec4899","#fbcfe8"], accent: "#f9a8d4", accentBright: "#ec4899", glassTint: "30,10,22" },
    obsidian: { wp: ["#09090b","#111113","#18181b","#27272a","#3f3f46","#52525b","#71717a","#a1a1aa"], accent: "#a1a1aa", accentBright: "#71717a", glassTint: "20,20,22" },
  };
  const DEFAULT_STATE = { theme: "scarlet", brightness: 72, saturation: 115, glass: 42 };
  const STORAGE_KEY = "orca-audio-cleanup-appearance-v1";
  const root = () => document.documentElement.style;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const rgba = (hex, a) => { const h = hex.replace("#", ""); return `rgba(${parseInt(h.slice(0,2),16)}, ${parseInt(h.slice(2,4),16)}, ${parseInt(h.slice(4,6),16)}, ${a})`; };
  // Near-black or white, whichever has the higher WCAG contrast on the accent (same rule as OrcaWorld).
  function inkOn(hex) {
    const lin = i => { const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const l = 0.2126 * lin(0) + 0.7152 * lin(1) + 0.0722 * lin(2);
    return (l + 0.05) / 0.05 > 1.05 / (l + 0.05) ? "#140806" : "#ffffff";
  }

  function loadState() {
    try {
      const p = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!p) return { ...DEFAULT_STATE };
      return {
        theme: THEMES[p.theme] ? p.theme : DEFAULT_STATE.theme,
        brightness: typeof p.brightness === "number" ? clamp(p.brightness, 30, 100) : DEFAULT_STATE.brightness,
        saturation: typeof p.saturation === "number" ? clamp(p.saturation, 0, 200) : DEFAULT_STATE.saturation,
        glass: typeof p.glass === "number" ? clamp(p.glass, 15, 80) : DEFAULT_STATE.glass,
      };
    } catch { return { ...DEFAULT_STATE }; }
  }
  const writeLocal = s => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch {} };
  function saveState(s) { writeLocal(s); pushShared(); }

  /* Shared with OrcaWorld (and any other Orca app) through this server's /api/appearance:
     switch the palette in one app and the others follow within a few seconds. */
  const shared = s => JSON.stringify({ theme: s.theme, brightness: s.brightness, saturation: s.saturation, glass: s.glass });
  let pushTimer, quietUntil = 0;
  // Debounced so a slider drag sends one write; incoming changes wait until it lands so they can't undo the drag.
  function pushShared() {
    clearTimeout(pushTimer); quietUntil = Date.now() + 2000;
    pushTimer = setTimeout(() => {
      fetch("/api/appearance", { method: "POST", headers: { "Content-Type": "application/json" }, body: shared(loadState()) })
        .catch(() => {}).finally(() => { quietUntil = Date.now() + 1000; });
    }, 300);
  }
  // Take the shared appearance if another Orca app changed it; the first app to run seeds the file with its own.
  async function syncShared() {
    if (document.hidden || Date.now() < quietUntil) return;
    const res = await fetch("/api/appearance").catch(() => null);
    const remote = res && res.ok ? (await res.json()).appearance : null;
    if (Date.now() < quietUntil) return;
    const local = loadState();
    if (!remote) { if (res && res.ok) pushShared(); return; }
    if (shared({ ...local, ...remote }) === shared(local)) return;
    writeLocal({ ...local, ...remote }); applyAll(loadState());
    window.dispatchEvent(new Event("orca-appearance"));
  }

  function applyGlass(val, tint) {
    const o = clamp(val, 15, 80) / 100, r = root();
    r.setProperty("--orca-glass", `rgba(${tint}, ${o.toFixed(2)})`);
    r.setProperty("--orca-glass-solid", `rgba(${tint}, ${Math.min(1, o + 0.3).toFixed(2)})`);
    r.setProperty("--orca-glass-hover", `rgba(${tint}, ${Math.min(1, o + 0.1).toFixed(2)})`);
  }
  function applyTheme(theme, state) {
    const p = THEMES[theme], r = root();
    p.wp.forEach((c, i) => r.setProperty(`--orca-wp-${i + 1}`, c));
    r.setProperty("--primary", p.accent);
    r.setProperty("--secondary", p.accentBright);
    r.setProperty("--orca-accent-glow", rgba(p.accent, 0.3));
    r.setProperty("--on-primary", inkOn(p.accent));
    r.setProperty("--gloss-primary", `linear-gradient(180deg, ${p.accentBright} 0%, ${p.accent} 100%)`);
    r.setProperty("--grad-primary", `linear-gradient(135deg, ${p.accent} 0%, ${p.accentBright} 100%)`);
    applyGlass(state.glass, p.glassTint);
  }
  const applyBrightness = v => root().setProperty("--orca-brightness", (clamp(v, 30, 100) / 100).toFixed(2));
  const applySaturation = v => root().setProperty("--orca-saturation", (clamp(v, 0, 200) / 100).toFixed(2));
  function applyAll(s) { applyTheme(s.theme, s); applyBrightness(s.brightness); applySaturation(s.saturation); }
  function dotGradient(t) { const w = THEMES[t].wp; return `linear-gradient(135deg, ${w.map((c, i) => `${c} ${Math.round(i / (w.length - 1) * 100)}%`).join(", ")})`; }

  /* Appearance selector — vanilla equivalent of OrcaAppearance.tsx.
     Keyboard: Escape closes; outside click closes; palette buttons use aria-pressed. */
  function mountAppearance(host) {
    let state = loadState();
    window.addEventListener("orca-appearance", () => { state = loadState(); if (panel) { panel.remove(); panel = null; open(); } });
    host.classList.add("orca-appearance-group");
    host.innerHTML = `<button class="btn btn-ghost btn-icon" type="button" aria-label="Appearance" aria-haspopup="dialog" aria-expanded="false" title="Appearance">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg></button>`;
    const btn = host.querySelector("button");
    let panel = null;
    const close = () => { if (!panel) return; panel.remove(); panel = null; btn.setAttribute("aria-expanded", "false"); btn.focus(); };
    const slider = (key, label, min, max, unit) => `<div class="orca-slider-group"><label class="orca-slider-label" for="orca-${key}"><span>${label}</span><span class="orca-slider-value" id="orca-${key}-v">${state[key]}${unit}</span></label><input id="orca-${key}" type="range" min="${min}" max="${max}" value="${state[key]}" data-k="${key}" data-u="${unit}"></div>`;
    function open() {
      panel = document.createElement("div");
      panel.className = "orca-appearance-dropdown"; panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "Appearance settings");
      panel.innerHTML = `<div class="orca-appearance-title">Theme</div><div class="orca-theme-dots">${Object.keys(THEMES).map(t => `<button type="button" class="orca-theme-dot ${t === state.theme ? "active" : ""}" style="background:${dotGradient(t)}" aria-label="${t[0].toUpperCase() + t.slice(1)} palette" aria-pressed="${t === state.theme}" title="${t}" data-t="${t}"></button>`).join("")}</div>
        <div class="orca-appearance-title">Adjust</div>${slider("brightness", "Brightness", 30, 100, "%")}${slider("saturation", "Saturation", 0, 200, "%")}${slider("glass", "Glass", 15, 80, "%")}`;
      host.appendChild(panel); btn.setAttribute("aria-expanded", "true");
      panel.addEventListener("click", e => {
        const d = e.target.closest(".orca-theme-dot"); if (!d) return;
        state = { ...state, theme: d.dataset.t }; applyTheme(state.theme, state); saveState(state);
        panel.querySelectorAll(".orca-theme-dot").forEach(x => { const on = x.dataset.t === state.theme; x.classList.toggle("active", on); x.setAttribute("aria-pressed", on); });
      });
      panel.addEventListener("input", e => {
        const k = e.target.dataset.k; if (!k) return;
        state = { ...state, [k]: +e.target.value }; saveState(state);
        panel.querySelector(`#orca-${k}-v`).textContent = e.target.value + e.target.dataset.u;
        if (k === "brightness") applyBrightness(state.brightness);
        else if (k === "saturation") applySaturation(state.saturation);
        else applyGlass(state.glass, THEMES[state.theme].glassTint);
      });
      panel.querySelector(".orca-theme-dot.active")?.focus();
    }
    btn.addEventListener("click", () => panel ? close() : open());
    document.addEventListener("mousedown", e => { if (panel && !host.contains(e.target)) close(); });
    document.addEventListener("keydown", e => { if (panel && e.key === "Escape") close(); });
  }

  applyAll(loadState()); // before first paint: script is loaded in <head>
  syncShared();
  addEventListener("focus", syncShared);
  document.addEventListener("visibilitychange", syncShared);
  setInterval(syncShared, 3000);
  window.Orca = { THEMES, loadState, saveState, applyAll, mountAppearance };
})();
