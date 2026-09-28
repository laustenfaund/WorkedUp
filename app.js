"use strict";
/* ---------- helpers ---------- */
/* Skip empty slots (null/false) when filling an element, so they never show up as the word "null". */
{ const rc = Element.prototype.replaceChildren;
  Element.prototype.replaceChildren = function (...k) { return rc.apply(this, k.flat(Infinity).filter(x => x != null && x !== false)); }; }
const $ = (s, r = document) => r.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-5);
const clone = o => JSON.parse(JSON.stringify(o));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  let late = null;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "value" || k === "checked") (late = late || {})[k] = v;
    else if (k === "for" || k.startsWith("aria-") || k.startsWith("data-") || k === "role") el.setAttribute(k, v === true ? "" : v);
    else if (k in el) { try { el[k] = v; } catch (e) { el.setAttribute(k, v); } }
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  if (late) for (const k in late) el[k] = late[k];
  return el;
}
const fmtDate = t => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
const slug = s => (s || "cards").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "cards";
const r2 = v => Math.round(v * 100) / 100;

/* ---------- storage (IndexedDB, with in-memory fallback) ---------- */
const DB = {
  db: null, mem: false, memKV: new Map(), memBlobs: new Map(),
  async open() {
    if (this.db || this.mem) return;
    try {
      this.db = await new Promise((res, rej) => {
        const r = indexedDB.open("worked-up-app", 1);
        r.onupgradeneeded = () => { const d = r.result; d.createObjectStore("kv"); d.createObjectStore("blobs"); };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
        setTimeout(() => rej(new Error("timeout")), 4000);
      });
    } catch (e) { this.mem = true; }
  },
  _store(name) { return name === "kv" ? this.memKV : this.memBlobs; },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode);
      const r = fn(t.objectStore(store));
      t.oncomplete = () => res(r && r.result);
      t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  },
  async get(s, k) { if (this.mem) return this._store(s).get(k); return this.tx(s, "readonly", st => st.get(k)); },
  async put(s, k, v) { if (this.mem) { this._store(s).set(k, v); return; } return this.tx(s, "readwrite", st => st.put(v, k)); },
  async del(s, k) { if (this.mem) { this._store(s).delete(k); return; } return this.tx(s, "readwrite", st => st.delete(k)); },
  async keys(s) { if (this.mem) return [...this._store(s).keys()]; return this.tx(s, "readonly", st => st.getAllKeys()); },
  async clear(s) { if (this.mem) { this._store(s).clear(); return; } return this.tx(s, "readwrite", st => st.clear()); }
};

const blobCache = new Map();
async function putBlob(blob) { const id = "b" + uid(); await DB.put("blobs", id, blob); return id; }
async function blobURL(id) {
  if (!id) return null;
  const c = blobCache.get(id); if (c) return c.url;
  const b = await DB.get("blobs", id); if (!b) return null;
  const url = URL.createObjectURL(b); blobCache.set(id, { url }); return url;
}
async function loadImg(id) {
  const url = await blobURL(id); if (!url) return null;
  const c = blobCache.get(id);
  if (!c.img) c.img = new Promise(res => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = url; });
  return c.img;
}
async function importImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const max = 2400, s = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(im.naturalWidth * s); c.height = Math.round(im.naturalHeight * s);
    c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.9));
    return await putBlob(blob);
  } catch (e) { toast("That image couldn't be opened. Try a JPG or PNG."); return null; }
  finally { URL.revokeObjectURL(url); }
}
function pickFile(accept, multiple) {
  return new Promise(res => {
    const inp = h("input", { type: "file", accept, multiple: !!multiple, style: "display:none" });
    inp.addEventListener("change", () => { res(multiple ? [...inp.files] : (inp.files[0] || null)); inp.remove(); });
    document.body.append(inp); inp.click();
  });
}
function blobRefs(s = state) {
  const refs = new Set();
  s.decks.forEach(d => d.cards.forEach(c => { c.bg.img && refs.add(c.bg.img); c.bg.orig && refs.add(c.bg.orig); }));
  s.fonts.forEach(f => f.blobId && refs.add(f.blobId));
  return refs;
}
async function gcBlob(id) {
  if (!id || blobRefs().has(id) || histHas(id)) return;
  await DB.del("blobs", id).catch(() => {});
  const c = blobCache.get(id); if (c) { URL.revokeObjectURL(c.url); blobCache.delete(id); }
}

/* ---------- state ---------- */
let state = null;
let settings = { geminiKey: "", textModel: "", imageModel: "", lang: "" };
let saveTimer = null;
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); if (window.Drive) Drive.markDirty(); }
async function saveNow() {
  clearTimeout(saveTimer); saveTimer = null;
  try { await DB.put("kv", "state", state); }
  catch (e) { toast("Couldn't save. Your browser storage may be full."); }
}
const saveSettings = () => DB.put("kv", "settings", settings).catch(() => {});
document.addEventListener("visibilitychange", () => { if (document.hidden && saveTimer) saveNow(); });
window.addEventListener("pagehide", () => { if (saveTimer) saveNow(); });
function touch(deck) { if (deck) { deck.updated = Date.now(); histTouch(deck); } saveSoon(); }

const ASPECTS = { "4:5": [1080, 1350], "1:1": [1080, 1080], "3:4": [1080, 1440], "9:16": [1080, 1920] };
const ASPECT_LABEL = { "4:5": "4:5 (best for feeds)", "1:1": "1:1 (square)", "3:4": "3:4", "9:16": "9:16 (Stories)" };
const SEED_FONTS = [
  ["Montserrat", "Montserrat:ital,wght@0,400;0,600;0,700;0,800;1,400;1,600;1,700;1,800"],
  ["Playfair Display", "Playfair+Display:ital,wght@0,400;0,700;1,400;1,700"],
  ["Anton", "Anton"],
  ["Bebas Neue", "Bebas+Neue"],
  ["Oswald", "Oswald:wght@400;700"],
  ["DM Serif Display", "DM+Serif+Display:ital@0;1"],
  ["Cormorant Garamond", "Cormorant+Garamond:ital,wght@0,400;0,600;1,400;1,600"],
  ["Libre Baskerville", "Libre+Baskerville:ital,wght@0,400;0,700;1,400"],
  ["Lora", "Lora:ital,wght@0,400;0,700;1,400;1,700"],
  ["Raleway", "Raleway:ital,wght@0,400;0,700;1,400;1,700"],
  ["Caveat", "Caveat:wght@400;700"],
  ["Pacifico", "Pacifico"],
  ["Special Elite", "Special+Elite"]
];
const PRELOADED = new Set(SEED_FONTS.map(f => f[0]));

function L(o) {
  return Object.assign({ id: uid(), text: "Text", font: "Montserrat", size: 60, weight: 700, italic: false, color: "#FFFFFF",
    align: "center", x: 0.5, y: 0.5, w: 0.8, opacity: 1, lh: 1.25, box: false, boxColor: "#000000", boxOpacity: 0.55, shadow: true }, o);
}
const ADJ0 = { bright: 0, contrast: 0, sat: 0, warm: 0, tint: 0, fade: 0, vignette: 0, grain: 0, blur: 0, sharpen: 0 };
function newBg(o) {
  const b = Object.assign({ img: null, orig: null, style: "", color: "#2B2522", color2: "#6B4A3A", look: "none", lookAmt: 1,
    duo1: "#1D2B4A", duo2: "#F4C77D", dim: 0.1, zoom: 1, fx: 0.5, fy: 0.5, rot: 0, flip: false }, o);
  b.adj = Object.assign({}, ADJ0, (o && o.adj) || {});
  return b;
}
function newCard(layers, bg) { return { id: uid(), bg: newBg(bg), layers: (layers || []).map(l => L(l)) }; }

function starterTypes() {
  const T = (name, layers, bg) => ({ id: uid(), name, card: newCard(layers, bg) });
  return [
    T("Title", [
      { text: "Big title", font: "Anton", size: 120, weight: 400, y: 0.45, w: 0.84, lh: 1.05 },
      { text: "a smaller line under it", font: "Montserrat", size: 40, weight: 600, italic: true, y: 0.6, w: 0.8 }
    ], { color: "#2B2522", color2: "#8A5A40" }),
    T("Statement", [{ text: "One strong line", font: "Montserrat", size: 90, weight: 800, italic: true, y: 0.5, w: 0.8, lh: 1.12 }]),
    T("Quote", [
      { text: "“Quote goes here”", font: "DM Serif Display", size: 72, weight: 400, y: 0.42, w: 0.82, lh: 1.25 },
      { text: "— Name", font: "Montserrat", size: 34, weight: 600, y: 0.66, opacity: 0.9 }
    ], { color: "#1F2430", color2: "#4B5A73" }),
    T("Caption", [{ text: "A caption at the bottom", font: "Montserrat", size: 40, weight: 600, y: 0.86, w: 0.8, box: true, boxOpacity: 0.6, boxShape: "rounded", shadow: false, lh: 1.35 }]),
    T("Photo only", [])
  ];
}
function cardFromType(t) { const c = clone(t.card); c.id = uid(); c.layers.forEach(l => l.id = uid()); c.bg = newBg(c.bg); return c; }
function seed() {
  const types = starterTypes();
  const by = n => types.find(t => t.name === n);
  const order = ["Title", "Statement", "Quote", "Caption", "Statement"];
  const now = Date.now();
  const example = { id: uid(), name: "Example deck", aspect: "4:5", created: now, updated: now, cards: order.map(n => cardFromType(by(n))) };
  return {
    v: 1,
    decks: [example],
    cardTypes: types,
    templates: [{ id: uid(), name: "Starter, 5 cards", aspect: "4:5", cards: order.map(n => cardFromType(by(n))) }],
    fonts: SEED_FONTS.map(([family, q]) => ({ family, source: "google", q })),
    usage: { fonts: {}, colors: ["#FFFFFF", "#F4C77D", "#1C1B19"] },
    lastStyle: null
  };
}

/* ---------- fonts ---------- */
const fontLoaded = new Set();
function fontStr(l, scale) { return `${l.italic ? "italic " : ""}${l.weight || 400} ${Math.max(1, Math.round(l.size * scale))}px "${l.font}", Georgia, serif`; }
async function ensureFont(l) {
  const key = `${l.italic ? "i" : "n"}${l.weight}|${l.font}`;
  if (fontLoaded.has(key)) return;
  try { await Promise.race([document.fonts.load(fontStr(l, 1).replace(/\d+px/, "40px")), new Promise(r => setTimeout(r, 3000))]); } catch (e) {}
  fontLoaded.add(key);
}
function addGoogleLink(q) {
  return new Promise(res => {
    const link = h("link", { rel: "stylesheet", href: `https://fonts.googleapis.com/css2?family=${q}&display=swap` });
    link.onload = () => res(true); link.onerror = () => { link.remove(); res(false); };
    document.head.append(link);
  });
}
async function loadCustomFont(f) {
  try {
    const b = await DB.get("blobs", f.blobId); if (!b) return false;
    const face = new FontFace(f.family, await b.arrayBuffer());
    await face.load(); document.fonts.add(face); return true;
  } catch (e) { return false; }
}
async function loadAllFonts() {
  for (const f of state.fonts) {
    if (f.source === "google" && !PRELOADED.has(f.family)) addGoogleLink(f.q);
    if (f.source === "custom") loadCustomFont(f);
  }
}
function fontsByUse() {
  const u = state.usage.fonts;
  return [...state.fonts].sort((a, b) => (u[b.family] || 0) - (u[a.family] || 0) || a.family.localeCompare(b.family));
}
function bumpFont(fam) { state.usage.fonts[fam] = (state.usage.fonts[fam] || 0) + 1; }
function rememberColor(c) {
  c = c.toUpperCase();
  state.usage.colors = [c, ...state.usage.colors.filter(x => x !== c)].slice(0, 10);
}
/* Adds a Google font by name. Returns the family as Google spells it, or null. */
async function tryGoogleFont(name) {
  const fam = String(name || "").trim().replace(/\s+/g, " ");
  if (!fam) return null;
  const have = state.fonts.find(f => f.family.toLowerCase() === fam.toLowerCase());
  if (have) return have.family;
  const plus = fam.replace(/ /g, "+");
  let q = plus + ":ital,wght@0,400;0,700;1,400;1,700";
  let ok = await addGoogleLink(q);
  if (!ok) { q = plus; ok = await addGoogleLink(q); }
  let faces = [];
  if (ok) { try { faces = await document.fonts.load(`16px "${fam}"`); } catch (e) {} }
  if (!ok || !faces.length) return null;
  state.fonts.push({ family: fam, source: "google", q }); saveSoon();
  return fam;
}

/* ---------- photo looks and adjustments ---------- */
const LOOKS = [
  ["none", "Original"], ["warm", "Warm"], ["cool", "Cool"], ["sepia", "Sepia"], ["mono", "Black & white"], ["noir", "Noir"],
  ["vintage", "Vintage"], ["faded", "Faded"], ["pop", "Pop"], ["dream", "Dreamy"], ["duotone", "Duotone"],
  ["posterize", "Poster"], ["halftone", "Comic dots"], ["pixelate", "Pixels"], ["sketch", "Pencil sketch"]
];
const LOOK_IDS = LOOKS.map(l => l[0]);
const ADJ_INFO = [
  ["bright", "Brightness", -1, 1], ["contrast", "Contrast", -1, 1], ["sat", "Color (saturation)", -1, 1], ["warm", "Warmth", -1, 1],
  ["tint", "Tint (green ↔ pink)", -1, 1], ["fade", "Fade", 0, 1], ["vignette", "Dark edges", 0, 1], ["grain", "Film grain", 0, 1],
  ["blur", "Blur", 0, 1], ["sharpen", "Sharpen", 0, 1]
];
function hexRGB(hx) { const m = /^#?([0-9a-f]{6})$/i.exec(hx || ""); const n = m ? parseInt(m[1], 16) : 0; return [n >> 16 & 255, n >> 8 & 255, n & 255]; }

/* Box blur, two passes each way, which looks close to a soft (gaussian) blur. ch = channels per pixel. */
function boxBlur(p, W, H, r, ch) {
  r = Math.max(1, Math.round(r)); const cn = ch === 4 ? 3 : 1, div = 2 * r + 1;
  const tmp = new Float32Array(p.length);
  const pass = (src, dst, horiz) => {
    const outer = horiz ? H : W, inner = horiz ? W : H;
    for (let o = 0; o < outer; o++) {
      const idx = i => (horiz ? o * W + i : i * W + o) * ch;
      for (let c = 0; c < cn; c++) {
        let sum = 0;
        for (let i = -r; i <= r; i++) sum += src[idx(clamp(i, 0, inner - 1)) + c];
        for (let i = 0; i < inner; i++) {
          dst[idx(i) + c] = sum / div;
          sum += src[idx(Math.min(i + r + 1, inner - 1)) + c] - src[idx(Math.max(i - r, 0)) + c];
        }
      }
    }
  };
  for (let k = 0; k < 2; k++) { pass(p, tmp, true); pass(tmp, p, false); }
}
function lookColor(look, r, g, b, bg, d1, d2) {
  const lum = r * .299 + g * .587 + b * .114;
  switch (look) {
    case "warm": return [r * 1.06 + 10, g + 4, b * .85];
    case "cool": return [r * .88, g + 2, b * 1.08 + 12];
    case "sepia": return [(r * .393 + g * .769 + b * .189) * .9 + 14, (r * .349 + g * .686 + b * .168) * .9 + 10, (r * .272 + g * .534 + b * .131) * .9 + 6];
    case "mono": return [lum, lum, lum];
    case "noir": { const v = (lum - 128) * 1.65 + 118; return [v, v, v]; }
    case "vintage": return [((r * .85 + lum * .15 + 22) - 128) * .9 + 128, ((g * .85 + lum * .15 + 12) - 128) * .9 + 128, ((b * .7 + lum * .1 + 10) - 128) * .9 + 128];
    case "faded": return [r * .8 + 40, g * .8 + 36, b * .75 + 46];
    case "pop": { const s = 1.55, c = 1.18; const f = v => ((lum + (v - lum) * s) - 128) * c + 128; return [f(r), f(g), f(b)]; }
    case "dream": return [r * .95 + 16, g * .95 + 10, b * .95 + 14];
    case "duotone": { const t = clamp(lum / 255, 0, 1); return [d1[0] + (d2[0] - d1[0]) * t, d1[1] + (d2[1] - d1[1]) * t, d1[2] + (d2[2] - d1[2]) * t]; }
    case "posterize": { const q = v => Math.round(clamp(v, 0, 255) / 255 * 3) / 3 * 255; return [q(r), q(g), q(b)]; }
    default: return [r, g, b];
  }
}
const COLOR_LOOKS = new Set(["warm", "cool", "sepia", "mono", "noir", "vintage", "faded", "pop", "dream", "duotone", "posterize"]);
function processBg(x, W, H, bg) {
  const a = Object.assign({}, ADJ0, bg.adj || {}), look = LOOK_IDS.includes(bg.look) ? bg.look : "none", amt = clamp(bg.lookAmt ?? 1, 0, 1);
  const anyAdj = ["bright", "contrast", "sat", "warm", "tint", "fade", "grain", "blur", "sharpen"].some(k => a[k]);
  if (anyAdj || (look !== "none" && look !== "halftone") || (look === "halftone" && amt > 0)) {
    const img = x.getImageData(0, 0, W, H), p = img.data;
    if (a.blur > 0) boxBlur(p, W, H, a.blur * W * 0.018, 4);
    if (a.sharpen > 0) {
      const b = new Uint8ClampedArray(p); boxBlur(b, W, H, W * 0.002, 4);
      const k = a.sharpen * 1.6; for (let i = 0; i < p.length; i += 4) for (let c = 0; c < 3; c++) p[i + c] = p[i + c] + (p[i + c] - b[i + c]) * k;
    }
    let glow = null;
    if (look === "dream" && amt > 0) { glow = new Uint8ClampedArray(p); boxBlur(glow, W, H, W * 0.012, 4); }
    const cK = a.contrast >= 0 ? 1 + a.contrast * 1.2 : 1 + a.contrast * 0.8, sK = 1 + a.sat;
    const d1 = hexRGB(bg.duo1), d2 = hexRGB(bg.duo2), colorLook = COLOR_LOOKS.has(look) && amt > 0;
    const doAdj = a.bright || a.contrast || a.sat || a.warm || a.tint || a.fade;
    if (doAdj || colorLook) for (let i = 0; i < p.length; i += 4) {
      let r = p[i], g = p[i + 1], b = p[i + 2];
      if (doAdj) {
        r += a.bright * 70; g += a.bright * 70; b += a.bright * 70;
        r = (r - 128) * cK + 128; g = (g - 128) * cK + 128; b = (b - 128) * cK + 128;
        const l = r * .299 + g * .587 + b * .114; r = l + (r - l) * sK; g = l + (g - l) * sK; b = l + (b - l) * sK;
        r += a.warm * 28 + a.tint * 8; g -= a.tint * 24; b += -a.warm * 28 + a.tint * 8;
        if (a.fade) { const f = a.fade; r = r * (1 - f * .28) + f * 48; g = g * (1 - f * .28) + f * 46; b = b * (1 - f * .28) + f * 52; }
      }
      if (colorLook) {
        if (glow) { r = r + (255 - r) * glow[i] / 255 * .55; g = g + (255 - g) * glow[i + 1] / 255 * .55; b = b + (255 - b) * glow[i + 2] / 255 * .55; }
        const [R, G, B] = lookColor(look, r, g, b, bg, d1, d2);
        r += (R - r) * amt; g += (G - g) * amt; b += (B - b) * amt;
      }
      p[i] = r; p[i + 1] = g; p[i + 2] = b;
    }
    if (look === "pixelate" && amt > 0) {
      const bs = Math.max(3, Math.round(W * (0.006 + 0.03 * amt)));
      for (let by = 0; by < H; by += bs) for (let bx = 0; bx < W; bx += bs) {
        let s0 = 0, s1 = 0, s2 = 0, n = 0; const ex = Math.min(bx + bs, W), ey = Math.min(by + bs, H);
        for (let y = by; y < ey; y++) for (let xx = bx; xx < ex; xx++) { const i = (y * W + xx) * 4; s0 += p[i]; s1 += p[i + 1]; s2 += p[i + 2]; n++; }
        s0 /= n; s1 /= n; s2 /= n;
        for (let y = by; y < ey; y++) for (let xx = bx; xx < ex; xx++) { const i = (y * W + xx) * 4; p[i] = s0; p[i + 1] = s1; p[i + 2] = s2; }
      }
    }
    if (look === "sketch" && amt > 0) {
      const n = W * H, gray = new Float32Array(n), inv = new Float32Array(n);
      for (let j = 0; j < n; j++) { const i = j * 4; gray[j] = p[i] * .299 + p[i + 1] * .587 + p[i + 2] * .114; inv[j] = 255 - gray[j]; }
      boxBlur(inv, W, H, W * 0.007, 1);
      for (let j = 0; j < n; j++) {
        let v = Math.min(255, gray[j] * 255 / Math.max(1, 256 - inv[j]));
        v = 255 * Math.pow(v / 255, 2.2);
        const i = j * 4; for (let c = 0; c < 3; c++) p[i + c] += (v - p[i + c]) * amt;
      }
    }
    if (a.grain > 0) {
      let seed = 1234567; const k = a.grain * 70;
      for (let i = 0; i < p.length; i += 4) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const nz = (seed / 0x7fffffff - 0.5) * k; p[i] += nz; p[i + 1] += nz; p[i + 2] += nz;
      }
    }
    x.putImageData(img, 0, 0);
  }
  if (look === "halftone" && amt > 0) {
    const src = x.getImageData(0, 0, W, H).data, orig = document.createElement("canvas");
    orig.width = W; orig.height = H; orig.getContext("2d").drawImage(x.canvas, 0, 0);
    const cell = Math.max(4, Math.round(W / 85));
    x.fillStyle = "#F3EEE3"; x.fillRect(0, 0, W, H); x.fillStyle = "#1C1B19";
    for (let y = 0; y < H; y += cell) for (let xx = 0; xx < W; xx += cell) {
      const cx = Math.min(W - 1, xx + (cell >> 1)), cy = Math.min(H - 1, y + (cell >> 1)), i = (cy * W + cx) * 4;
      const dark = 1 - (src[i] * .299 + src[i + 1] * .587 + src[i + 2] * .114) / 255;
      const rad = cell * 0.62 * Math.sqrt(dark); if (rad < 0.4) continue;
      x.beginPath(); x.arc(xx + cell / 2, y + cell / 2, rad, 0, Math.PI * 2); x.fill();
    }
    if (amt < 1) { x.globalAlpha = 1 - amt; x.drawImage(orig, 0, 0); x.globalAlpha = 1; }
  }
  if (a.vignette > 0) {
    const g = x.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.hypot(W, H) / 2);
    g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, `rgba(0,0,0,${a.vignette * 0.85})`);
    x.fillStyle = g; x.fillRect(0, 0, W, H);
  }
}

/* ---------- rendering ---------- */
const bgCache = new Map(), turnCache = new Map();
function turned(img, id, rot, flip) {
  rot = ((rot || 0) % 4 + 4) % 4;
  if (!rot && !flip) return img;
  const key = [id, rot, !!flip].join("|");
  if (turnCache.has(key)) return turnCache.get(key);
  const w = img.naturalWidth, hh = img.naturalHeight, c = document.createElement("canvas");
  c.width = rot % 2 ? hh : w; c.height = rot % 2 ? w : hh;
  const x = c.getContext("2d");
  x.translate(c.width / 2, c.height / 2); x.rotate(rot * Math.PI / 2); if (flip) x.scale(-1, 1);
  x.drawImage(img, -w / 2, -hh / 2);
  c.naturalWidth = c.width; c.naturalHeight = c.height;
  turnCache.set(key, c); if (turnCache.size > 8) turnCache.delete(turnCache.keys().next().value);
  return c;
}
async function bgCanvas(bg, W, H) {
  const key = JSON.stringify([bg, W, H]);
  if (bgCache.has(key)) return bgCache.get(key);
  const raw = bg.img ? await loadImg(bg.img) : null;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const x = c.getContext("2d", { willReadFrequently: true });
  if (raw) {
    const img = turned(raw, bg.img, bg.rot, bg.flip);
    const s = Math.max(W / img.naturalWidth, H / img.naturalHeight) * (bg.zoom || 1);
    const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
    x.drawImage(img, (W - dw) * (bg.fx ?? .5), (H - dh) * (bg.fy ?? .5), dw, dh);
  } else {
    const g = x.createLinearGradient(0, 0, W * 0.35, H);
    g.addColorStop(0, bg.color || "#2B2522"); g.addColorStop(1, bg.color2 || bg.color || "#6B4A3A");
    x.fillStyle = g; x.fillRect(0, 0, W, H);
  }
  processBg(x, W, H, bg);
  if (bg.dim > 0) { x.fillStyle = `rgba(0,0,0,${bg.dim})`; x.fillRect(0, 0, W, H); }
  bgCache.set(key, c);
  if (bgCache.size > 40) bgCache.delete(bgCache.keys().next().value);
  return c;
}
function wrapLines(x, text, maxW) {
  const out = [];
  for (const para of String(text).split("\n")) {
    if (!para.trim()) { out.push(""); continue; }
    const parts = para.split(/(\s+)/); let line = "";
    for (const w of parts) {
      const test = line + w;
      if (x.measureText(test).width > maxW && line.trim()) { out.push(line.trimEnd()); line = w.trimStart(); }
      else line = test;
    }
    out.push(line.trimEnd());
  }
  return out;
}
function drawLayer(x, l, W, H, scale) {
  x.save();
  x.font = fontStr(l, scale);
  const maxW = l.w * W, fs = l.size * scale, lh = fs * (l.lh || 1.25);
  const lines = wrapLines(x, l.text || " ", maxW);
  const bw = Math.max(1, ...lines.map(s => x.measureText(s).width));
  const blockH = lines.length * lh, cx = l.x * W, cy = l.y * H, align = l.align || "center";
  const left = align === "left" ? cx - maxW / 2 : align === "right" ? cx + maxW / 2 - bw : cx - bw / 2;
  const top = cy - blockH / 2, padX = fs * 0.55, padY = fs * 0.35;
  let bb = { x: left - padX, y: top - padY, w: bw + padX * 2, h: blockH + padY * 2 };
  if (l.box) {
    x.globalAlpha = l.boxOpacity ?? .55; x.fillStyle = l.boxColor || "#000"; x.beginPath();
    const shape = l.boxShape || "square";
    const rad = (w, hh) => shape === "pill" ? hh / 2 : shape === "rounded" ? Math.min(w, hh) * 0.22 : 0;
    if ((l.boxFit || "block") === "line") {
      const lx = fs * 0.5, lhh = fs * 1.35; let minX = Infinity, maxX = -Infinity;
      lines.forEach((s, i) => {
        if (!s.trim()) return;
        const tw = x.measureText(s).width, cyL = top + lh * (i + 0.5);
        const sx = align === "left" ? cx - maxW / 2 : align === "right" ? cx + maxW / 2 - tw : cx - tw / 2;
        const r = { x: sx - lx, y: cyL - lhh / 2, w: tw + lx * 2, h: lhh };
        roundRectPath(x, r.x, r.y, r.w, r.h, rad(r.w, r.h));
        minX = Math.min(minX, r.x); maxX = Math.max(maxX, r.x + r.w);
      });
      if (minX < Infinity) bb = { x: minX, y: top + lh / 2 - lhh / 2, w: maxX - minX, h: blockH - lh + lhh };
    } else {
      const px2 = shape === "pill" ? padX * 1.3 : padX;
      bb = { x: left - px2, y: top - padY, w: bw + px2 * 2, h: blockH + padY * 2 };
      roundRectPath(x, bb.x, bb.y, bb.w, bb.h, rad(bb.w, bb.h));
    }
    x.fill("nonzero");
  }
  x.globalAlpha = l.opacity ?? 1; x.fillStyle = l.color || "#fff"; x.textBaseline = "middle"; x.textAlign = align;
  if (l.shadow) { x.shadowColor = "rgba(0,0,0,.45)"; x.shadowBlur = fs * 0.25; x.shadowOffsetY = fs * 0.04; }
  const ax = align === "left" ? cx - maxW / 2 : align === "right" ? cx + maxW / 2 : cx;
  lines.forEach((s, i) => x.fillText(s, ax, top + lh * (i + 0.5)));
  x.restore();
  return { id: l.id, x: Math.min(bb.x, left - padX), y: Math.min(bb.y, top - padY), w: Math.max(bb.x + bb.w, left + bw + padX) - Math.min(bb.x, left - padX), h: Math.max(bb.y + bb.h, top + blockH + padY) - Math.min(bb.y, top - padY) };
}
function roundRectPath(x, rx, ry, w, hh, r) {
  r = Math.max(0, Math.min(r, w / 2, hh / 2));
  x.moveTo(rx + r, ry); x.lineTo(rx + w - r, ry); x.arcTo(rx + w, ry, rx + w, ry + r, r);
  x.lineTo(rx + w, ry + hh - r); x.arcTo(rx + w, ry + hh, rx + w - r, ry + hh, r);
  x.lineTo(rx + r, ry + hh); x.arcTo(rx, ry + hh, rx, ry + hh - r, r);
  x.lineTo(rx, ry + r); x.arcTo(rx, ry, rx + r, ry, r); x.closePath();
}
async function renderCard(card, cv, W, H, opt = {}) {
  const scale = opt.scale || 1, w = Math.round(W * scale), hh = Math.round(H * scale);
  const seq = (cv._seq = (cv._seq || 0) + 1);
  const bg = await bgCanvas(card.bg, w, hh);
  await Promise.all(card.layers.map(ensureFont));
  if (seq !== cv._seq) return null;
  if (cv.width !== w) cv.width = w;
  if (cv.height !== hh) cv.height = hh;
  const x = cv.getContext("2d");
  x.clearRect(0, 0, w, hh); x.drawImage(bg, 0, 0);
  const bounds = card.layers.map(l => drawLayer(x, l, w, hh, scale));
  if (opt.selectedId) {
    const b = bounds.find(b => b.id === opt.selectedId);
    if (b) { x.save(); x.strokeStyle = "rgba(255,255,255,.9)"; x.lineWidth = 3 * scale; x.setLineDash([12 * scale, 9 * scale]); x.strokeRect(b.x, b.y, b.w, b.h); x.restore(); }
  }
  return bounds;
}

/* ---------- UI primitives ---------- */
function toast(msg, action) {
  document.querySelectorAll(".toast").forEach(t => t.remove());
  const t = h("div", { class: "toast", role: "status" }, h("span", {}, msg), action && h("button", { onclick: () => { t.remove(); action.fn(); } }, action.label));
  document.body.append(t); setTimeout(() => t.remove(), action ? 8000 : 3500);
}
function sheet(title, content, opts = {}) {
  const ov = h("div", { class: "overlay" });
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); opts.onClose && opts.onClose(); };
  const onKey = e => { if (e.key === "Escape") close(); };
  ov.addEventListener("click", e => { if (e.target === ov) close(); });
  const body = h("div", { class: "sheetbody" }, content);
  ov.append(h("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": title },
    h("div", { class: "sheethead" }, h("h2", {}, title), h("button", { class: "btn ghost", onclick: close }, "Close")), body));
  document.body.append(ov); document.addEventListener("keydown", onKey);
  return { close, body };
}
function askText(title, initial = "", okLabel = "Save") {
  return new Promise(res => {
    let done = false;
    const inp = h("input", { class: "field", id: "ask-text", value: initial, autocomplete: "off" });
    const ok = () => { done = true; const v = inp.value.trim(); s.close(); res(v || null); };
    inp.addEventListener("keydown", e => { if (e.key === "Enter") ok(); });
    const s = sheet(title, [inp, h("div", { class: "row end" }, h("button", { class: "btn", onclick: () => s.close() }, "Cancel"), h("button", { class: "btn primary", onclick: ok }, okLabel))],
      { onClose: () => { if (!done) res(null); } });
    setTimeout(() => { inp.focus(); inp.select(); }, 30);
  });
}
function confirmSheet(msg, okLabel = "Delete") {
  return new Promise(res => {
    let done = false;
    const s = sheet("Are you sure?", [h("p", {}, msg), h("div", { class: "row end" },
      h("button", { class: "btn", onclick: () => s.close() }, "Cancel"),
      h("button", { class: "btn primary", onclick: () => { done = true; s.close(); res(true); } }, okLabel))],
      { onClose: () => { if (!done) res(false); } });
  });
}
function choose(title, options, extra) {
  return new Promise(res => {
    let done = false;
    const s = sheet(title, [
      extra || null,
      ...options.map(o => h("button", { class: "choice", onclick: () => { done = true; s.close(); res(o.value); } }, h("span", {}, o.label), o.sub && h("span", { class: "sub" }, o.sub)))
    ], { onClose: () => { if (!done) res(null); } });
  });
}
function rangeRow(label, id, val, min, max, step, onInput) {
  const num = h("input", { type: "number", class: "field", id: id + "-n", min, max, step, value: val });
  const rng = h("input", { type: "range", id, min, max, step, value: val });
  rng.addEventListener("input", () => { num.value = rng.value; onInput(+rng.value); });
  num.addEventListener("input", () => { if (num.value === "") return; rng.value = num.value; onInput(clamp(+num.value, min, max * 4)); });
  return h("div", {}, h("label", { class: "lbl", for: id }, label), h("div", { class: "rng" }, rng, num));
}

function saveFile(filename, data) {
  const a = h("a", { href: URL.createObjectURL(data), download: filename, style: "display:none" });
  document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  return true;
}
async function shareFiles(files, title) {
  const list = files.map(([n, b]) => new File([b], n, { type: b.type || "image/png" }));
  if (!navigator.canShare || !navigator.canShare({ files: list })) { toast("Sharing files isn't available in this browser. Use Save instead."); return; }
  try { await navigator.share({ files: list, title }); }
  catch (e) { if (e && e.name !== "AbortError") toast("Sharing didn't work. Use Save instead."); }
}
function driveButton(label, onFiles, opts) {
  if (!window.Drive || !Drive.enabled) return null;
  return h("button", { class: "btn", "data-drive": "1", onclick: async () => {
    if (!Drive.connected) { toast("Connect Google Drive first, in Library."); return; }
    const files = await Drive.pick(opts); if (files.length) onFiles(files);
  } }, label);
}
async function fontFromFile(f) {
  const fam = await askText("Name for this font", f.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " "), "Add"); if (!fam) return;
  const blobId = await putBlob(f);
  const entry = { family: fam, source: "custom", blobId };
  if (!await loadCustomFont(entry)) { await DB.del("blobs", blobId); toast("That font file couldn't be read."); return; }
  state.fonts.push(entry); saveSoon(); if (ui.screen === "library") renderLibrary(); toast(`Added ${fam}.`);
}
const isFont = f => /\.(ttf|otf|woff2?)$/i.test(f.name);
/* CSS color names ("gold", "navy") and hex codes both become #RRGGBB. */
const colorCtx = document.createElement("canvas").getContext("2d");
function normColor(v) {
  if (typeof v !== "string" || !v.trim()) return null;
  colorCtx.fillStyle = "#010203"; colorCtx.fillStyle = v.trim();
  const out = colorCtx.fillStyle;
  if (out === "#010203" && !/^#?010203$/i.test(v.trim())) return null;
  return /^#[0-9a-f]{6}$/i.test(out) ? out.toUpperCase() : null;
}

/* ---------- undo / redo (per open deck) ---------- */
const hist = { deckId: null, base: null, undo: [], redo: [], open: false, timer: null, applying: false };
const snapDeck = d => JSON.stringify({ name: d.name, aspect: d.aspect, cards: d.cards });
function histReset(deck) { clearTimeout(hist.timer); Object.assign(hist, { deckId: deck.id, base: snapDeck(deck), undo: [], redo: [], open: false }); paintUndo(); }
function histTouch(deck) {
  if (hist.applying || deck.id !== hist.deckId) return;
  if (!hist.open) { hist.undo.push(hist.base); if (hist.undo.length > 80) hist.undo.shift(); hist.redo = []; hist.open = true; }
  clearTimeout(hist.timer); hist.timer = setTimeout(histSettle, 900);
  paintUndo();
}
function histSettle() {
  clearTimeout(hist.timer);
  const d = state.decks.find(x => x.id === hist.deckId);
  if (d) hist.base = snapDeck(d);
  hist.open = false;
}
const histHas = id => hist.base && (hist.base.includes(id) || hist.undo.some(s => s.includes(id)) || hist.redo.some(s => s.includes(id)));
function histStep(dir) {
  const deck = curDeck(); if (!deck || deck.id !== hist.deckId) return false;
  if (hist.open) histSettle();
  const from = dir < 0 ? hist.undo : hist.redo, to = dir < 0 ? hist.redo : hist.undo;
  if (!from.length) { toast(dir < 0 ? "Nothing to undo." : "Nothing to redo."); return false; }
  to.push(hist.base);
  const s = from.pop(); hist.base = s;
  hist.applying = true;
  Object.assign(deck, JSON.parse(s)); deck.updated = Date.now(); saveSoon();
  hist.applying = false;
  if (ui.cardId && !curCard()) { ui.cardId = null; }
  if (ui.layerId && !curLayer()) ui.layerId = null;
  paintUndo(); renderDeck();
  return true;
}
const undo = () => histStep(-1), redo = () => histStep(1);
function paintUndo() {
  const u = $("#undoBtn"), r = $("#redoBtn"); if (!u) return;
  u.disabled = !hist.undo.length; r.disabled = !hist.redo.length;
}

/* ---------- navigation ---------- */
const ui = { screen: "decks", deckId: null, cardId: null, layerId: null, tab: "text" };
const main = $("#main");
document.querySelectorAll(".nav button").forEach(b => b.addEventListener("click", () => go(b.dataset.go)));
function go(screen, arg) {
  ui.screen = screen;
  if (screen === "deck") { ui.deckId = arg; ui.cardId = null; ui.layerId = null; const d = curDeck(); if (d && hist.deckId !== d.id) histReset(d); }
  document.querySelectorAll(".nav button").forEach(b => b.setAttribute("aria-current", (b.dataset.go === screen || (screen === "deck" && b.dataset.go === "decks")) ? "page" : "false"));
  $("#vbar").hidden = screen !== "deck"; document.body.classList.toggle("hasbar", screen === "deck");
  window.scrollTo(0, 0);
  ({ decks: renderDecks, deck: renderDeck, library: renderLibrary })[screen]();
}

/* ---------- Decks ---------- */
function makeDeck(name, cards, aspect = "4:5") {
  const now = Date.now();
  const d = { id: uid(), name, aspect, created: now, updated: now, cards };
  state.decks.push(d); saveSoon(); return d;
}
function copyCards(cards, keepImages) {
  return clone(cards).map(c => { c.id = uid(); c.layers.forEach(l => l.id = uid()); if (!keepImages) { c.bg.img = null; c.bg.orig = null; c.bg.style = ""; } return c; });
}
function renderDecks() {
  const grid = h("div", { class: "decks" });
  const decks = [...state.decks].sort((a, b) => b.updated - a.updated);
  main.replaceChildren(
    h("div", { class: "row between" }, h("h2", {}, "Decks"), h("div", { class: "row" }, h("button", { class: "btn", onclick: newDeckFromFlow }, "Start from…"), h("button", { class: "btn primary", onclick: newDeckFlow }, "New deck"))),
    grid);
  if (!decks.length) { grid.append(h("div", { class: "empty", style: "grid-column:1/-1" }, "No decks yet. Make one with New deck.")); return; }
  for (const d of decks) {
    const cv = h("canvas", { "aria-hidden": "true" });
    const [W, H] = ASPECTS[d.aspect] || ASPECTS["4:5"];
    if (d.cards[0]) renderCard(d.cards[0], cv, W, H, { scale: 0.2 }); else { cv.width = 216; cv.height = 270; }
    grid.append(h("article", { class: "deckcard" },
      h("button", { class: "cover", onclick: () => go("deck", d.id), "aria-label": "Open " + d.name }, cv),
      h("div", { class: "info" },
        h("div", { class: "name" }, d.name),
        h("div", { class: "small muted" }, `${d.cards.length} card${d.cards.length === 1 ? "" : "s"} · edited ${fmtDate(d.updated)}`),
        h("div", { class: "row" },
          h("button", { class: "btn small", onclick: () => go("deck", d.id) }, "Open"),
          h("button", { class: "btn small", onclick: async () => { const nm = await askText("Rename deck", d.name); if (nm) { d.name = nm; touch(d); renderDecks(); } } }, "Rename"),
          h("button", { class: "btn small", onclick: () => deckMenu(d) }, "More")))));
  }
}
async function deckMenu(d) {
  const v = await choose(d.name, [
    { label: "Duplicate", sub: "Copy the deck, photos included", value: "dup" },
    { label: "Save as template", sub: "Keep its cards and text styles to start future decks", value: "tmpl" },
    { label: "Delete deck", sub: "Removes it for good", value: "del" }
  ]);
  if (v === "dup") { makeDeck(d.name + " copy", copyCards(d.cards, true), d.aspect); renderDecks(); toast("Deck duplicated."); }
  if (v === "tmpl") saveTemplate(d);
  if (v === "del") {
    if (!await confirmSheet(`Delete “${d.name}” and its ${d.cards.length} cards?`)) return;
    const imgs = d.cards.flatMap(c => [c.bg.img, c.bg.orig]);
    state.decks = state.decks.filter(x => x !== d); saveSoon();
    if (hist.deckId === d.id) Object.assign(hist, { deckId: null, base: null, undo: [], redo: [] });
    for (const i of imgs) await gcBlob(i);
    renderDecks();
  }
}
async function saveTemplate(d) {
  const nm = await askText("Template name", d.name); if (!nm) return;
  state.templates.push({ id: uid(), name: nm, aspect: d.aspect, cards: copyCards(d.cards, false) });
  saveSoon(); toast(`Saved template “${nm}”.`);
}
function defaultDeckName() {
  return "Post, " + new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function newDeckFlow() {
  const deck = makeDeck(defaultDeckName(), Array.from({ length: 5 }, () => newCard([])));
  go("deck", deck.id);
}
async function newDeckFromFlow() {
  const opts = [];
  state.templates.forEach(t => opts.push({ label: t.name, sub: `Template · ${t.cards.length} cards`, value: "t:" + t.id }));
  [...state.decks].sort((a, b) => b.updated - a.updated).slice(0, 6).forEach(d => opts.push({ label: "Copy of " + d.name, sub: "Text and layout, without photos", value: "d:" + d.id }));
  if (!opts.length) { toast("No templates or decks to start from yet."); return; }
  const v = await choose("Start from", opts); if (!v) return;
  let deck;
  if (v.startsWith("t:")) { const t = state.templates.find(x => x.id === v.slice(2)); deck = makeDeck(defaultDeckName(), copyCards(t.cards, false), t.aspect); }
  else { const s = state.decks.find(x => x.id === v.slice(2)); deck = makeDeck(defaultDeckName(), copyCards(s.cards, false), s.aspect); }
  go("deck", deck.id);
}

/* ---------- Deck editor ---------- */
const curDeck = () => state.decks.find(d => d.id === ui.deckId);
const curCard = () => curDeck()?.cards.find(c => c.id === ui.cardId);
const curLayer = () => curCard()?.layers.find(l => l.id === ui.layerId);
let preview = null, bounds = [], rafPending = false;

function isEmptyCard(c) { return !c.bg.img && !c.layers.length; }
function renderDeck() {
  const deck = curDeck(); if (!deck) return go("decks");
  if (ui.cardId && !curCard()) { ui.cardId = null; ui.layerId = null; }
  paintUndo();
  return ui.cardId ? renderEditor(deck) : renderOverview(deck);
}
function deckNameInput(deck) {
  const nameInp = h("input", { class: "deckname", id: "deck-name", value: deck.name, "aria-label": "Deck name" });
  nameInp.addEventListener("input", () => { deck.name = nameInp.value; touch(deck); });
  return nameInp;
}
function addEmptyCard() {
  const deck = curDeck(); deck.cards.push(newCard([])); touch(deck); renderDeck();
}
async function removeLastCard() {
  const deck = curDeck(); const c = deck.cards[deck.cards.length - 1]; if (!c) return;
  if (!isEmptyCard(c) && !await confirmSheet(`Card ${deck.cards.length} has content. Remove it?`, "Remove")) return;
  deck.cards.pop(); touch(deck); renderDeck();
}
async function photosAsCards() {
  const files = (await pickFile("image/*", true)).filter(f => f.type.startsWith("image/")); if (!files.length) return;
  await addPhotoCards(files);
}
async function addPhotoCards(files) {
  const deck = curDeck(); let n = 0;
  toast(`Bringing in ${files.length} photo${files.length === 1 ? "" : "s"}…`);
  for (const f of files) { const id = await importImage(f); if (!id) continue; deck.cards.push(newCard([], { img: id })); n++; }
  if (n) { touch(deck); renderDeck(); toast(`Added ${n} card${n === 1 ? "" : "s"}.`); }
}
function renderOverview(deck) {
  const [W, H] = ASPECTS[deck.aspect] || ASPECTS["4:5"];
  const aspect = h("select", { class: "field", id: "aspect", style: "width:auto", "aria-label": "Card size", value: deck.aspect },
    Object.keys(ASPECTS).map(a => h("option", { value: a }, ASPECT_LABEL[a])));
  aspect.value = deck.aspect;
  aspect.addEventListener("change", () => { deck.aspect = aspect.value; touch(deck); renderDeck(); });
  const grid = h("div", { class: "cardgrid", style: `--ar:${W / H}` });
  deck.cards.forEach((c, i) => {
    const cv = h("canvas", { "aria-hidden": "true" });
    renderCard(c, cv, W, H, { scale: 0.3 });
    const tile = h("button", { class: "tile", "data-id": c.id, "aria-label": `Card ${i + 1}${isEmptyCard(c) ? ", empty" : ""}`, onclick: () => { ui.cardId = c.id; ui.layerId = null; renderDeck(); } },
      cv, h("span", { class: "num" }, i + 1), isEmptyCard(c) ? h("span", { class: "emptylbl" }, "Empty") : null);
    tile.addEventListener("dragover", e => { if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) { e.preventDefault(); tile.classList.add("dropping"); } });
    tile.addEventListener("dragleave", () => tile.classList.remove("dropping"));
    tile.addEventListener("drop", async e => {
      tile.classList.remove("dropping");
      const f = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith("image/")); if (!f) return;
      e.preventDefault(); e.stopPropagation();
      const id = await importImage(f); if (!id) return;
      setPhoto(c, id); touch(deck); renderDeck();
    });
    grid.append(tile);
  });
  grid.append(h("button", { class: "tile addtile", onclick: addEmptyCard, "aria-label": "Add an empty card" }, "+"));
  main.replaceChildren(
    h("div", { class: "deckbar" },
      h("button", { class: "btn ghost", onclick: () => go("decks") }, "‹ Decks"), deckNameInput(deck),
      h("button", { class: "btn primary", onclick: () => openExport(deck), disabled: !deck.cards.length }, "Share")),
    h("div", { class: "row between", style: "margin-bottom:12px" },
      h("div", { class: "row" },
        h("button", { class: "btn", onclick: removeLastCard, disabled: !deck.cards.length, "aria-label": "Remove last card" }, "−"),
        h("span", { class: "count" }, `${deck.cards.length} card${deck.cards.length === 1 ? "" : "s"}`),
        h("button", { class: "btn", onclick: addEmptyCard, "aria-label": "Add an empty card" }, "+"),
        h("button", { class: "btn", onclick: photosAsCards }, "Photos → cards")),
      aspect),
    grid,
    h("p", { class: "small muted", style: "margin-top:12px" }, "Tap a card to edit it. Drag cards to change their order; on a phone, press and hold first."));
  if (window.Sortable && deck.cards.length > 1) Sortable.create(grid, {
    animation: 160, delay: 220, delayOnTouchOnly: true, filter: ".addtile", preventOnFilter: false, ghostClass: "sort-ghost",
    onMove: e => !e.related.classList.contains("addtile"),
    onEnd: e => {
      if (e.oldIndex === e.newIndex) return;
      const [c] = deck.cards.splice(e.oldIndex, 1); deck.cards.splice(e.newIndex, 0, c); touch(deck); renderDeck();
    }
  });
}
function renderEditor(deck) {
  const [W, H] = ASPECTS[deck.aspect] || ASPECTS["4:5"];
  const idx = deck.cards.findIndex(c => c.id === ui.cardId);
  const goTo = j => { ui.cardId = deck.cards[j].id; ui.layerId = null; renderDeck(); };
  preview = h("canvas", { id: "preview", "aria-label": "Card preview. Tap text to select it, drag to move it. Drag the photo to reframe it." });
  preview.style.setProperty("--ar", W / H);
  wirePreview(preview);
  main.replaceChildren(
    h("div", { class: "deckbar" },
      h("button", { class: "btn ghost", onclick: () => { ui.cardId = null; ui.layerId = null; renderDeck(); } }, "‹ All cards"),
      h("div", { class: "cardnav" },
        h("button", { class: "btn small", disabled: idx <= 0, onclick: () => goTo(idx - 1), "aria-label": "Previous card" }, "‹"),
        h("span", {}, `Card ${idx + 1} of ${deck.cards.length}`),
        h("button", { class: "btn small", disabled: idx >= deck.cards.length - 1, onclick: () => goTo(idx + 1), "aria-label": "Next card" }, "›")),
      h("button", { class: "btn primary", onclick: () => openExport(deck) }, "Share")),
    h("div", { class: "editor" },
      h("div", { class: "stagewrap" }, h("div", { class: "stage" }, preview), cardActions(deck)),
      h("div", { class: "panel", id: "panel" })));
  drawPreview(); renderPanel();
}
function cardActions(deck) {
  const idx = deck.cards.findIndex(c => c.id === ui.cardId);
  const move = dir => { const j = idx + dir; if (j < 0 || j >= deck.cards.length) return; const [c] = deck.cards.splice(idx, 1); deck.cards.splice(j, 0, c); touch(deck); renderDeck(); };
  return h("div", { class: "row cardacts" },
    h("button", { class: "btn small", onclick: () => move(-1), disabled: idx <= 0 }, "Move earlier"),
    h("button", { class: "btn small", onclick: () => move(1), disabled: idx >= deck.cards.length - 1 }, "Move later"),
    h("button", { class: "btn small", onclick: applyCardType }, "Use card type"),
    h("button", { class: "btn small", onclick: () => { const c = copyCards([curCard()], true)[0]; deck.cards.splice(idx + 1, 0, c); ui.cardId = c.id; touch(deck); renderDeck(); } }, "Duplicate"),
    h("button", { class: "btn small", onclick: saveCardType }, "Save as card type"),
    h("button", { class: "btn small ghost danger", onclick: async () => {
      if (!isEmptyCard(curCard()) && !await confirmSheet("Delete this card?")) return;
      deck.cards.splice(idx, 1); ui.cardId = null; ui.layerId = null;
      touch(deck); renderDeck();
    } }, "Delete card"));
}
function useCardType(card, t) {
  const n = cardFromType(t), bg = card.bg;
  card.layers = n.layers;
  card.bg = Object.assign(n.bg, { img: bg.img, orig: bg.orig, style: bg.style, fx: bg.fx, fy: bg.fy, zoom: bg.zoom, rot: bg.rot, flip: bg.flip });
  if (!bg.img) { card.bg.color = n.bg.color; card.bg.color2 = n.bg.color2; }
}
async function applyCardType() {
  if (!state.cardTypes.length) { toast("No card types yet. Save one with Save as card type."); return; }
  const v = await choose("Use card type", state.cardTypes.map(t => ({ label: t.name, sub: `${t.card.layers.length} text piece${t.card.layers.length === 1 ? "" : "s"}`, value: t.id })));
  if (!v) return;
  const card = curCard();
  if (card.layers.length && !await confirmSheet("This replaces the text on this card. Your photo stays.", "Replace")) return;
  useCardType(card, state.cardTypes.find(x => x.id === v));
  ui.layerId = card.layers[0]?.id || null; changed(); renderPanel();
}
async function saveCardType() {
  const nm = await askText("Name this card type", ""); if (!nm) return;
  const c = copyCards([curCard()], false)[0];
  state.cardTypes.push({ id: uid(), name: nm, card: c }); saveSoon();
  toast(`Saved card type “${nm}”.`);
}
function previewScale(W) {
  const w = preview?.getBoundingClientRect().width || Math.min(window.innerWidth, 600);
  return clamp(w * (window.devicePixelRatio || 1) / W, 0.35, 1);
}
/* fast: a low-resolution draw while sliders or drags are moving; the sharp one follows when they stop. */
let sharpTimer = null;
function drawPreview(fast) {
  const deck = curDeck(), card = curCard(); if (!card || !preview) return;
  const [W, H] = ASPECTS[deck.aspect] || ASPECTS["4:5"];
  const full = previewScale(W), scale = fast ? Math.min(full, 0.4) : full;
  renderCard(card, preview, W, H, { selectedId: ui.layerId, scale }).then(b => { if (b) bounds = b; });
  clearTimeout(sharpTimer);
  if (fast && scale < full) sharpTimer = setTimeout(() => drawPreview(false), 300);
}
function changed(opts = {}) {
  const deck = curDeck(); touch(deck);
  if (!rafPending) { rafPending = true; requestAnimationFrame(() => { rafPending = false; drawPreview(true); }); }
  if (opts.style) { const l = curLayer(); if (l) { const s = clone(l); delete s.id; delete s.text; delete s.x; delete s.y; state.lastStyle = s; } }
}
function setPhoto(card, id) {
  card.bg.img = id; card.bg.orig = null; card.bg.style = ""; card.bg.zoom = 1; card.bg.fx = 0.5; card.bg.fy = 0.5; card.bg.rot = 0; card.bg.flip = false;
}
function wirePreview(cv) {
  let drag = null;
  cv.addEventListener("dragover", e => { if ([...(e.dataTransfer?.types || [])].includes("Files")) { e.preventDefault(); cv.classList.add("dropping"); } });
  cv.addEventListener("dragleave", () => cv.classList.remove("dropping"));
  cv.addEventListener("drop", async e => {
    cv.classList.remove("dropping");
    const card = curCard(); if (!card) return;
    e.preventDefault(); e.stopPropagation();
    const f = [...(e.dataTransfer.files || [])].find(f => f.type.startsWith("image/")); if (!f) return;
    const id = await importImage(f); if (!id) return;
    setPhoto(card, id); changed(); renderPanel();
  });
  const frac = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
  cv.addEventListener("pointerdown", async e => {
    const [fx, fy] = frac(e), px = fx * cv.width, py = fy * cv.height;
    const hit = [...bounds].reverse().find(b => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h);
    const card = curCard(); if (!card) return;
    cv.setPointerCapture(e.pointerId); e.preventDefault();
    if (!hit) {
      if (ui.layerId || ui.tab === "text") { ui.layerId = null; ui.tab = card.bg.img ? "photo" : ui.tab; drawPreview(); renderPanel(); }
      if (!card.bg.img) return;
      const img = await loadImg(card.bg.img); if (!img) return;
      const [W, H] = ASPECTS[curDeck().aspect] || ASPECTS["4:5"];
      const t = turned(img, card.bg.img, card.bg.rot, card.bg.flip);
      const s = Math.max(W / t.naturalWidth, H / t.naturalHeight) * (card.bg.zoom || 1);
      drag = { photo: true, sx: fx, sy: fy, ox: card.bg.fx, oy: card.bg.fy, ow: (t.naturalWidth * s - W) / W, oh: (t.naturalHeight * s - H) / H };
      return;
    }
    const l = card.layers.find(x => x.id === hit.id);
    if (ui.layerId !== l.id) { ui.layerId = l.id; ui.tab = "text"; renderPanel(); }
    drag = { l, sx: fx, sy: fy, ox: l.x, oy: l.y };
    drawPreview();
  });
  cv.addEventListener("pointermove", e => {
    if (!drag) return;
    const [fx, fy] = frac(e);
    if (drag.photo) {
      const bg = curCard().bg;
      if (drag.ow > 0.001) bg.fx = clamp(drag.ox - (fx - drag.sx) / drag.ow, 0, 1);
      if (drag.oh > 0.001) bg.fy = clamp(drag.oy - (fy - drag.sy) / drag.oh, 0, 1);
      changed(); return;
    }
    let nx = drag.ox + (fx - drag.sx), ny = drag.oy + (fy - drag.sy);
    if (Math.abs(nx - 0.5) < 0.012) nx = 0.5;
    if (Math.abs(ny - 0.5) < 0.012) ny = 0.5;
    drag.l.x = clamp(nx, -0.2, 1.2); drag.l.y = clamp(ny, -0.2, 1.2); changed();
  });
  const end = () => { if (drag && drag.photo && ui.tab === "photo") renderPanel(); drag = null; };
  cv.addEventListener("pointerup", end); cv.addEventListener("pointercancel", end);
}

function renderPanel() {
  const panel = $("#panel"); if (!panel) return;
  const tabs = [["text", "Text"], ["photo", "Photo"], ["look", "Look"]];
  const tabBar = h("div", { class: "tabs", role: "tablist" }, tabs.map(([k, lbl]) =>
    h("button", { role: "tab", "aria-selected": ui.tab === k ? "true" : "false", onclick: () => { ui.tab = k; renderPanel(); } }, lbl)));
  const body = ui.tab === "text" ? textPanel() : ui.tab === "photo" ? photoPanel() : lookPanel();
  panel.replaceChildren(tabBar, ...[].concat(body).flat(Infinity).filter(Boolean));
}
function newLayer(text) {
  const base = state.lastStyle ? clone(state.lastStyle) : {};
  return L(Object.assign(base, { id: uid(), text, x: 0.5, y: 0.5 }));
}
function textPanel() {
  const card = curCard(), l = curLayer();
  const chips = h("div", { class: "chips" },
    card.layers.map(x => h("button", { class: "chip", "aria-pressed": x.id === ui.layerId ? "true" : "false", onclick: () => { ui.layerId = x.id; drawPreview(); renderPanel(); } }, (x.text || "(empty)").split("\n")[0].slice(0, 28))),
    h("button", { class: "chip", onclick: () => { const nl = newLayer("New text"); card.layers.push(nl); ui.layerId = nl.id; changed(); renderPanel(); setTimeout(() => { const t = $("#layer-text"); t && (t.focus(), t.select()); }, 20); } }, "+ Text"));
  if (!l) return [chips, h("p", { class: "muted small" }, card.layers.length ? "Tap a piece of text on the card, or pick one above." : "Add text with + Text, or say “add text that says…”.")];

  const set = (k, v, style = true) => { l[k] = v; changed({ style }); };
  const ta = h("textarea", { class: "field", id: "layer-text", value: l.text, rows: 3, "aria-label": "Text. Type, paste, or use your keyboard's microphone." });
  ta.addEventListener("input", () => { l.text = ta.value; changed(); renderChipsLabel(); });
  function renderChipsLabel() { const c = chips.querySelector('[aria-pressed="true"]'); if (c) c.textContent = (l.text || "(empty)").split("\n")[0].slice(0, 28); }

  const fontSel = h("select", { class: "field", id: "layer-font", value: l.font, "aria-label": "Font" },
    fontsByUse().map(f => h("option", { value: f.family, style: `font-family:"${f.family}"` }, f.family)));
  if (!state.fonts.find(f => f.family === l.font)) fontSel.prepend(h("option", { value: l.font }, l.font + " (missing)"));
  fontSel.value = l.font;
  fontSel.addEventListener("change", () => { bumpFont(fontSel.value); set("font", fontSel.value); });

  const tog = (label, on, fn, aria) => h("button", { class: "btn small" + (on ? " on" : ""), "aria-pressed": on ? "true" : "false", "aria-label": aria || label, onclick: fn }, label);
  const styleRow = h("div", { class: "row" },
    tog("B", l.weight >= 600, () => { set("weight", l.weight >= 600 ? 400 : 700); renderPanel(); }, "Bold"),
    tog("I", l.italic, () => { set("italic", !l.italic); renderPanel(); }, "Italic"),
    h("span", { style: "width:6px" }),
    ...["left", "center", "right"].map(a => tog(a[0].toUpperCase() + a.slice(1), l.align === a, () => { set("align", a); renderPanel(); }, "Align " + a)),
    h("span", { style: "width:6px" }),
    tog("Shadow", l.shadow, () => { set("shadow", !l.shadow); renderPanel(); }),
    tog("Box", l.box, () => { set("box", !l.box); renderPanel(); }));

  const weightSel = h("select", { class: "field", id: "layer-weight", value: String(l.weight), "aria-label": "Weight" },
    [300, 400, 500, 600, 700, 800].map(w => h("option", { value: String(w) }, { 300: "Light", 400: "Regular", 500: "Medium", 600: "Semibold", 700: "Bold", 800: "Extra bold" }[w])));
  weightSel.value = String(l.weight);
  weightSel.addEventListener("change", () => { set("weight", +weightSel.value); renderPanel(); });

  const colorInp = h("input", { type: "color", id: "layer-color", value: l.color, "aria-label": "Text color" });
  colorInp.addEventListener("input", () => set("color", colorInp.value.toUpperCase()));
  colorInp.addEventListener("change", () => { rememberColor(colorInp.value); saveSoon(); renderPanel(); });
  const swatches = h("div", { class: "swatches" }, colorInp, state.usage.colors.map(c =>
    h("button", { class: "sw", style: `background:${c}`, "aria-label": "Use color " + c, onclick: () => { set("color", c); rememberColor(c); renderPanel(); } })));

  const seg = (label, key, opts, def) => h("div", {}, h("div", { class: "lbl" }, label), h("div", { class: "row" },
    opts.map(([v, t]) => tog(t, (l[key] || def) === v, () => { set(key, v); renderPanel(); }, label + ": " + t))));
  const shapeRow = l.box ? h("div", { class: "grid2" },
    seg("Box shape", "boxShape", [["square", "Square"], ["rounded", "Rounded"], ["pill", "Pill"]], "square"),
    seg("Box fits", "boxFit", [["block", "Whole block"], ["line", "Each line"]], "block")) : null;
  const boxRow = l.box ? h("div", { class: "grid2" },
    h("div", {}, h("label", { class: "lbl", for: "box-color" }, "Box color"),
      (() => { const i = h("input", { type: "color", id: "box-color", value: l.boxColor }); i.addEventListener("input", () => set("boxColor", i.value)); return i; })()),
    rangeRow("Box opacity", "box-op", l.boxOpacity, 0, 1, 0.05, v => set("boxOpacity", v))) : null;

  const idx = card.layers.indexOf(l);
  const order = h("div", { class: "row" },
    h("button", { class: "btn small", onclick: () => { l.x = 0.5; changed(); } }, "Center across"),
    h("button", { class: "btn small", onclick: () => { l.y = 0.5; changed(); } }, "Center up/down"),
    h("button", { class: "btn small", disabled: idx >= card.layers.length - 1, onclick: () => { card.layers.splice(idx, 1); card.layers.splice(idx + 1, 0, l); changed(); renderPanel(); } }, "Bring forward"),
    h("button", { class: "btn small", onclick: () => { const c = clone(l); c.id = uid(); c.y = clamp(l.y + 0.08, 0, 1); card.layers.push(c); ui.layerId = c.id; changed(); renderPanel(); } }, "Duplicate"),
    h("button", { class: "btn small ghost danger", onclick: () => { card.layers.splice(idx, 1); ui.layerId = null; changed(); renderPanel(); } }, "Delete text"));

  return [chips, ta,
    h("div", { class: "grid2" }, h("div", {}, h("label", { class: "lbl", for: "layer-font" }, "Font"), fontSel), h("div", {}, h("label", { class: "lbl", for: "layer-weight" }, "Weight"), weightSel)),
    styleRow,
    rangeRow("Size", "layer-size", l.size, 12, 200, 1, v => set("size", v)),
    h("div", {}, h("label", { class: "lbl", for: "layer-color" }, "Color"), swatches),
    h("div", { class: "grid2" },
      rangeRow("Width", "layer-w", Math.round(l.w * 100), 10, 100, 1, v => set("w", v / 100, false)),
      rangeRow("Line spacing", "layer-lh", l.lh, 0.8, 2.4, 0.05, v => set("lh", v))),
    rangeRow("Opacity", "layer-op", l.opacity, 0.1, 1, 0.05, v => set("opacity", v)),
    shapeRow, boxRow,
    h("hr", { class: "divider" }), order];
}
function photoPanel() {
  const card = curCard(), bg = card.bg;
  const set = (k, v) => { bg[k] = v; changed(); };
  const usePhoto = async f => { if (!f) return; const id = await importImage(f); if (!id) return; setPhoto(card, id); changed(); renderPanel(); };
  const photoRow = h("div", { class: "row" },
    h("button", { class: "btn primary", onclick: async () => usePhoto(await pickFile("image/*")) }, bg.img ? "Replace photo" : "Add photo"),
    driveButton("From Drive", files => usePhoto(files.find(f => f.type.startsWith("image/")) || files[0]), { images: true }),
    bg.img ? h("button", { class: "btn ghost danger", onclick: () => { bg.img = null; bg.orig = null; bg.style = ""; changed(); renderPanel(); } }, "Remove photo") : null);
  const colorPick = (lbl, id, k) => { const i = h("input", { type: "color", id, value: bg[k] }); i.addEventListener("input", () => set(k, i.value.toUpperCase())); return h("div", {}, h("label", { class: "lbl", for: id }, lbl), i); };
  return [
    photoRow,
    bg.img ? [
      h("p", { class: "small muted", style: "margin:0" }, "Drag the photo on the card to reframe it."),
      rangeRow("Zoom", "bg-zoom", bg.zoom, 1, 4, 0.02, v => set("zoom", v)),
      h("div", { class: "grid2" },
        rangeRow("Left / right", "bg-fx", Math.round(bg.fx * 100), 0, 100, 1, v => set("fx", v / 100)),
        rangeRow("Up / down", "bg-fy", Math.round(bg.fy * 100), 0, 100, 1, v => set("fy", v / 100))),
      h("div", { class: "row" },
        h("button", { class: "btn small", onclick: () => { bg.rot = ((bg.rot || 0) + 1) % 4; changed(); } }, "Rotate"),
        h("button", { class: "btn small", onclick: () => { bg.flip = !bg.flip; changed(); } }, "Mirror"),
        h("button", { class: "btn small", onclick: () => { Object.assign(bg, { zoom: 1, fx: 0.5, fy: 0.5, rot: 0, flip: false }); changed(); renderPanel(); } }, "Reset framing"))
    ] : [h("p", { class: "small muted", style: "margin:0" }, "No photo. The card uses a two-color fade."),
      h("div", { class: "row" }, colorPick("Top color", "bg-c1", "color"), colorPick("Bottom color", "bg-c2", "color2"))],
    rangeRow("Darken", "bg-dim", bg.dim, 0, 0.8, 0.01, v => set("dim", v))
  ];
}
function lookPanel() {
  const card = curCard(), bg = card.bg;
  const deck = curDeck(), [W, H] = ASPECTS[deck.aspect] || ASPECTS["4:5"];
  const grid = h("div", { class: "looks" });
  for (const [id, label] of LOOKS) {
    const cv = h("canvas", { "aria-hidden": "true" });
    renderCard({ bg: Object.assign(clone(bg), { look: id, lookAmt: id === "none" ? bg.lookAmt : Math.max(bg.lookAmt, 0.6) }), layers: [] }, cv, W, H, { scale: 0.08 });
    grid.append(h("button", { class: "look", "aria-pressed": (bg.look || "none") === id ? "true" : "false", onclick: () => { bg.look = id; if (bg.lookAmt < 0.2) bg.lookAmt = 1; changed(); renderPanel(); } }, cv, label));
  }
  const duo = bg.look === "duotone" ? h("div", { class: "row" }, ...[["duo1", "Shadows"], ["duo2", "Highlights"]].map(([k, lbl]) => {
    const i = h("input", { type: "color", id: "bg-" + k, value: bg[k] }); i.addEventListener("input", () => { bg[k] = i.value.toUpperCase(); changed(); });
    return h("div", {}, h("label", { class: "lbl", for: "bg-" + k }, lbl), i);
  })) : null;
  const adj = h("details", {}, h("summary", {}, "Adjust (brightness, contrast, color…)"),
    h("div", { class: "stack", style: "margin-top:10px" }, ADJ_INFO.map(([k, lbl, mn, mx]) =>
      rangeRow(lbl, "adj-" + k, bg.adj[k] || 0, mn, mx, 0.05, v => { bg.adj[k] = v; changed(); }))));
  if (Object.values(bg.adj).some(v => v)) adj.open = true;
  const presets = ["Watercolor painting", "Oil painting", "Pencil drawing", "Charcoal sketch", "Storybook illustration", "Impressionist painting", "Stained glass", "Vintage film photo"];
  const ai = h("section", { class: "stack", style: "gap:8px" },
    h("h3", {}, "Restyle with AI"),
    bg.img ? [
      h("div", { class: "chips" }, presets.map(p => h("button", { class: "chip", onclick: () => restyleFromPanel(card, p) }, p))),
      (() => {
        const inp = h("input", { class: "field", id: "ai-style", placeholder: "Or describe a style, e.g. soft pastel chalk" });
        return h("form", { class: "row", style: "flex-wrap:nowrap", onsubmit: e => { e.preventDefault(); if (inp.value.trim()) restyleFromPanel(card, inp.value.trim()); } }, inp, h("button", { class: "btn", type: "submit" }, "Restyle"));
      })(),
      bg.orig ? h("div", { class: "row" }, h("span", { class: "small muted" }, `Now: ${bg.style || "restyled"}`),
        h("button", { class: "btn small", onclick: () => { bg.img = bg.orig; bg.orig = null; bg.style = ""; changed(); renderPanel(); } }, "Back to original photo")) : null
    ] : h("p", { class: "small muted", style: "margin:0" }, "Add a photo first. AI restyling works on photos."));
  return [
    grid,
    bg.look && bg.look !== "none" ? rangeRow("Look strength", "bg-amt", bg.lookAmt, 0, 1, 0.05, v => { bg.lookAmt = v; changed(); }) : null,
    duo, adj,
    h("div", { class: "row" }, h("button", { class: "btn small", onclick: () => { bg.look = "none"; bg.lookAmt = 1; bg.adj = Object.assign({}, ADJ0); changed(); renderPanel(); } }, "Reset look")),
    h("hr", { class: "divider" }), ai
  ];
}
async function restyleFromPanel(card, prompt) {
  const panel = $("#panel"); panel && panel.classList.add("working");
  vSay(`Restyling as <b>${esc(prompt)}</b>… this can take 10 to 30 seconds.`);
  try { await restyle(card, prompt); touch(curDeck()); vSay(`Restyled as <b>${esc(prompt)}</b>.`, true); }
  catch (e) { vSay(esc(aiError(e))); }
  finally { panel && panel.classList.remove("working"); if (ui.screen === "deck") renderDeck(); }
}

/* ---------- AI (Google Gemini, with Molly's own key) ---------- */
const GEMINI = "https://generativelanguage.googleapis.com/v1beta/";
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function aiError(e) {
  if (e && e.code === "nokey") return "Add your Gemini key in Library › Voice and AI first.";
  if (e && e.code === "noimage") return "The AI didn't send back a picture. Try wording the style differently.";
  if (e && e.code === "nophoto") return "That card has no photo to restyle.";
  if (e && e.code === "parse") return "Didn't catch that. Try saying it another way.";
  if (e && e.status === 400 && /key/i.test(e.message || "")) return "Google says the Gemini key isn't valid. Check it in Library.";
  if (e && (e.status === 401 || e.status === 403)) return "Google turned down the Gemini key. Check it in Library.";
  if (e && e.status === 404) return "That AI model isn't available on this key. Open Library › Voice and AI and tap Check key.";
  if (e && e.status === 429) return "Too many AI requests, or the key is out of credit. Wait a minute and try again.";
  if (!navigator.onLine) return "You're offline. Voice changes and AI styles need the internet.";
  return "The AI request didn't work" + (e && e.message ? `: ${String(e.message).slice(0, 120)}` : ".");
}
async function gemini(model, body) {
  if (!settings.geminiKey) throw { code: "nokey" };
  const r = await fetch(`${GEMINI}models/${model}:generateContent`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": settings.geminiKey }, body: JSON.stringify(body)
  });
  if (!r.ok) { let m = ""; try { m = (await r.json()).error.message; } catch (e) {} throw { status: r.status, message: m }; }
  return r.json();
}
/* Picks the newest Flash text model and Flash image model this key can use. */
async function pickModels() {
  const r = await fetch(`${GEMINI}models?pageSize=1000`, { headers: { "x-goog-api-key": settings.geminiKey } });
  if (!r.ok) { let m = ""; try { m = (await r.json()).error.message; } catch (e) {} throw { status: r.status, message: m }; }
  const names = ((await r.json()).models || []).filter(m => (m.supportedGenerationMethods || []).includes("generateContent")).map(m => m.name.replace(/^models\//, ""));
  const ver = n => parseFloat((/gemini-(\d+(?:\.\d+)?)/.exec(n) || [0, 0])[1]);
  const rank = list => list.sort((a, b) => ver(b) - ver(a) || /preview|exp/.test(a) - /preview|exp/.test(b) || a.length - b.length)[0];
  const text = rank(names.filter(n => /^gemini-[\d.]+-flash(-preview)?(-\d\d-\d\d\d?\d?)?$/.test(n)));
  const image = rank(names.filter(n => /^gemini-[\d.]+-flash-image/.test(n) && !/lite/.test(n)))
    || rank(names.filter(n => /^gemini-[\d.]+-(pro|flash)[\w.-]*-image/.test(n)));
  return { text, image };
}
async function ensureModels() {
  if (settings.textModel && settings.imageModel) return;
  const m = await pickModels();
  settings.textModel = settings.textModel || m.text || "gemini-2.5-flash";
  settings.imageModel = settings.imageModel || m.image || "gemini-3.1-flash-image";
  saveSettings();
}
async function jpegB64(id, max = 1536) {
  const im = await loadImg(id); if (!im) throw { code: "nophoto" };
  const s = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight)), c = document.createElement("canvas");
  c.width = Math.round(im.naturalWidth * s); c.height = Math.round(im.naturalHeight * s);
  c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.9).split(",")[1];
}
/* Restyles a card's photo. Always works from the original photo, so styles don't pile up. */
async function restyle(card, prompt) {
  const src = card.bg.orig || card.bg.img; if (!src) throw { code: "nophoto" };
  await ensureModels();
  const data = await jpegB64(src);
  const j = await gemini(settings.imageModel, {
    contents: [{ role: "user", parts: [
      { text: `Redraw this photo as: ${prompt}. Keep the same scene, subjects, composition and framing. Do not add any text, lettering, signatures, borders or watermarks.` },
      { inline_data: { mime_type: "image/jpeg", data } }] }],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"] }
  });
  const part = (j.candidates?.[0]?.content?.parts || []).find(p => p.inlineData || p.inline_data);
  if (!part) throw { code: "noimage" };
  const d = part.inlineData || part.inline_data;
  const bin = atob(d.data), buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  const id = await putBlob(new Blob([buf], { type: d.mimeType || d.mime_type || "image/png" }));
  card.bg.orig = src; card.bg.img = id; card.bg.style = prompt;
}

/* ---------- voice ---------- */
const SYS = `You turn spoken editing commands into JSON edits for a phone app that makes multi-card social media posts (Instagram/Facebook carousels). Each card is an image 1080px wide with a photo or color background and text pieces on top.
Reply with JSON only: {"say": string, "actions": [ ... ]}
"say": a short plain summary of what you did (under 12 words), or one short question if the command is unclear (then "actions" is []).

Which card and text:
- Cards are numbered from 1. If a command doesn't name a card, use currentCard. "This card" = currentCard. "Next card" = currentCard + 1.
- If a command doesn't name a text piece, use the selected one. If none is selected and the card has one text piece, use it. "Title"/"heading" = the largest text on the card; "caption"/"small text" = the smallest.
- "All cards"/"every card" means one action per card.
- If the card is empty and the user dictates words, add a text piece.

Actions:
{"do":"text","card":n,"id":"<text id>","set":{...}}   change a text piece
{"do":"text","card":n,"id":"new","set":{"text":"...", ...}}   add a text piece
{"do":"delete_text","card":n,"id":"<text id>"}
{"do":"photo","card":n,"set":{...}}   change the photo/background ("adj" merges with current values)
{"do":"reset_photo","card":n}   remove the look and all adjustments
{"do":"restyle","card":n,"prompt":"watercolor painting"}   AI restyle of the photo
{"do":"original_photo","card":n}   undo an AI restyle, back to the original photo
{"do":"choose_photo","card":n}   the user wants to pick or change the photo
{"do":"remove_photo","card":n}
{"do":"select","card":n,"id":"<text id>" or "photo"}   open a card, optionally select a piece
{"do":"overview"}   show all cards
{"do":"add_cards","count":k,"after":n,"type":"<card type name or empty>"}
{"do":"delete_card","card":n}
{"do":"move_card","card":n,"to":m}
{"do":"duplicate_card","card":n}
{"do":"card_type","card":n,"name":"<card type name>"}   apply a saved layout
{"do":"size","aspect":"4:5"|"1:1"|"3:4"|"9:16"}
{"do":"rename_deck","name":"..."}
{"do":"export"}   the user wants to save or share the finished images
{"do":"undo"} / {"do":"redo"}

Text fields: text, font (from fonts, or any Google Fonts family name), size (px, 12-200), weight (300-800), italic, color, align (left|center|right), x, y (center of the text, 0-1 of card width/height; top ≈ 0.15, middle 0.5, bottom ≈ 0.85), w (width 0.1-1), opacity (0.1-1), lh (line spacing 0.8-2.4), shadow, box (colored box behind text), boxColor, boxOpacity (0-1), boxShape (square|rounded|pill), boxFit (block|line).
Photo fields: look, lookAmt (0-1), duo1/duo2 (duotone shadow and highlight colors), adj {bright, contrast, sat, warm, tint: -1..1; fade, vignette, grain, blur, sharpen: 0..1}, dim (darken, 0-0.8), zoom (1-4, 1 = just fills the card), fx/fy (0-1, which part of the photo shows; "move the photo up" = increase fy, "move it left" = increase fx), rot (quarter turns 0-3), flip (mirror), color/color2 (fade colors when there's no photo).
Looks: none (original), warm, cool, sepia, mono (black and white), noir (high-contrast black and white), vintage, faded, pop (vivid), dream (soft glow), duotone, posterize (poster), halftone (comic dots), pixelate, sketch (pencil sketch).
Painting or drawing styles the looks can't do (watercolor, oil painting, charcoal, cartoon, anime, stained glass, mosaic, etc.) use "restyle".

Amounts: values are absolute, so compute them from the current state. "A little" ≈ 10%, plain ("bigger", "brighter") ≈ 25%, "a lot"/"much" ≈ 50%. For adj sliders add 0.1 / 0.25 / 0.5 to the current value.
Colors: "#RRGGBB".
Dictated words: use them exactly as spoken, fixing only punctuation and capitalization. Keep references like "John 3:16". "New line" means a line break. Never invent wording.`;

function stateForAI() {
  const deck = curDeck(), idx = deck.cards.findIndex(c => c.id === ui.cardId);
  const nz = o => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v).map(([k, v]) => [k, r2(v)]));
  return {
    deck: deck.name, aspect: deck.aspect, cardCount: deck.cards.length,
    currentCard: idx >= 0 ? idx + 1 : null,
    selected: idx < 0 ? null : ui.layerId || "photo",
    cards: deck.cards.map((c, i) => ({
      card: i + 1,
      photo: c.bg.img ? (c.bg.orig ? `restyled as ${c.bg.style}` : "yes") : "none",
      look: c.bg.look, lookAmt: c.bg.lookAmt, adj: nz(c.bg.adj), dim: r2(c.bg.dim), zoom: r2(c.bg.zoom), fx: r2(c.bg.fx), fy: r2(c.bg.fy),
      ...(c.bg.img ? {} : { color: c.bg.color, color2: c.bg.color2 }),
      texts: c.layers.map(l => ({ id: l.id, text: (l.text || "").slice(0, 160), font: l.font, size: l.size, weight: l.weight, italic: l.italic, color: l.color, align: l.align,
        x: r2(l.x), y: r2(l.y), w: r2(l.w), opacity: l.opacity, lh: l.lh, shadow: l.shadow, box: l.box, ...(l.box ? { boxColor: l.boxColor, boxOpacity: l.boxOpacity, boxShape: l.boxShape || "square" } : {}) }))
    })),
    fonts: state.fonts.map(f => f.family),
    cardTypes: state.cardTypes.map(t => t.name)
  };
}
function vSay(html, withUndo) {
  const m = $("#vmsg"); if (m) m.innerHTML = html;
  paintUndo();
}
let busy = false;
async function runCommand(raw) {
  const text = String(raw || "").trim(); if (!text || busy) return;
  const inp = $("#vinput"); inp.value = "";
  const quick = text.toLowerCase().replace(/[.!?]+$/, "");
  if (/^(undo|undo that|go back|never ?mind|oops|take that back)$/.test(quick)) { if (undo()) vSay(`<b>“${esc(text)}”</b> · Undone.`); return; }
  if (/^redo( that)?$/.test(quick)) { if (redo()) vSay(`<b>“${esc(text)}”</b> · Redone.`); return; }
  if (!settings.geminiKey) { vSay(`<b>“${esc(text)}”</b> · Add your Gemini key in Library first.`); toast("Voice changes need a Gemini key.", { label: "Add key", fn: () => go("library") }); return; }
  busy = true; $("#vbar").classList.add("working");
  vSay(`<b>“${esc(text)}”</b> · Working…`);
  try {
    await ensureModels();
    const j = await gemini(settings.textModel, {
      systemInstruction: { parts: [{ text: SYS }] },
      contents: [{ role: "user", parts: [{ text: "State:\n" + JSON.stringify(stateForAI()) + "\n\nCommand: " + text }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
    });
    const out = (j.candidates?.[0]?.content?.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join("");
    let plan; try { plan = JSON.parse(out.replace(/^```(?:json)?|```$/g, "").trim()); } catch (e) { throw { code: "parse" }; }
    const actions = Array.isArray(plan.actions) ? plan.actions : [];
    if (hist.open) histSettle();
    const notes = await applyActions(actions, text);
    if (hist.open) histSettle();
    vSay(`<b>“${esc(text)}”</b> · ${esc([plan.say || (actions.length ? "Done." : "Not sure what to change."), ...notes].join(" "))}`);
  } catch (e) {
    vSay(`<b>“${esc(text)}”</b> · ${esc(aiError(e))}`);
  } finally {
    busy = false; $("#vbar").classList.remove("working");
    if (ui.screen === "deck") renderDeck();
  }
}
const LAYER_NUM = { size: [8, 300], weight: [100, 900], x: [-0.2, 1.2], y: [-0.2, 1.2], w: [0.1, 1], opacity: [0.05, 1], lh: [0.7, 3], boxOpacity: [0, 1] };
const BG_NUM = { lookAmt: [0, 1], dim: [0, 0.9], zoom: [1, 4], fx: [0, 1], fy: [0, 1] };
const ADJ_RANGE = Object.fromEntries(ADJ_INFO.map(([k, , mn, mx]) => [k, [mn, mx]]));
async function applyLayerSet(l, set) {
  for (const [k, v] of Object.entries(set || {})) {
    if (k in LAYER_NUM) { if (Number.isFinite(+v)) l[k] = clamp(+v, ...LAYER_NUM[k]); }
    else if (k === "text") l.text = String(v);
    else if (k === "color" || k === "boxColor") { const c = normColor(v); if (c) { l[k] = c; if (k === "color") rememberColor(c); } }
    else if (k === "align" && ["left", "center", "right"].includes(v)) l.align = v;
    else if (k === "boxShape" && ["square", "rounded", "pill"].includes(v)) l.boxShape = v;
    else if (k === "boxFit" && ["block", "line"].includes(v)) l.boxFit = v;
    else if (["italic", "box", "shadow"].includes(k)) l[k] = !!v;
    else if (k === "font") { const fam = await tryGoogleFont(v); if (fam) { l.font = fam; bumpFont(fam); } else return `Couldn't find the font “${v}”.`; }
  }
  return null;
}
function applyBgSet(bg, set) {
  for (const [k, v] of Object.entries(set || {})) {
    if (k in BG_NUM) { if (Number.isFinite(+v)) bg[k] = clamp(+v, ...BG_NUM[k]); }
    else if (k === "look" && LOOK_IDS.includes(v)) { bg.look = v; if (!("lookAmt" in set) && bg.lookAmt < 0.2) bg.lookAmt = 1; }
    else if (["duo1", "duo2", "color", "color2"].includes(k)) { const c = normColor(v); if (c) bg[k] = c; }
    else if (k === "rot" && Number.isFinite(+v)) bg.rot = ((Math.round(+v) % 4) + 4) % 4;
    else if (k === "flip") bg.flip = !!v;
    else if (k === "adj" && v && typeof v === "object") for (const [ak, av] of Object.entries(v)) if (ak in ADJ_RANGE && Number.isFinite(+av)) bg.adj[ak] = clamp(+av, ...ADJ_RANGE[ak]);
  }
}
async function applyActions(actions, heard) {
  const deck = curDeck(), notes = [];
  const cardAt = n => (n == null || n === "") ? (curCard() || null) : deck.cards[clamp(Math.round(+n) || 1, 1, Math.max(1, deck.cards.length)) - 1] || null;
  for (const a of actions) {
    if (!a || typeof a !== "object") continue;
    const card = cardAt(a.card);
    const needCard = () => { if (!card) notes.push("Open a card first, or say which card."); return !!card; };
    switch (a.do) {
      case "text": {
        if (!needCard()) break;
        let l = a.id && a.id !== "new" ? card.layers.find(x => x.id === a.id) : null;
        if (!l) { l = newLayer("Text"); card.layers.push(l); }
        const n = await applyLayerSet(l, a.set); if (n) notes.push(n);
        if (card.id === ui.cardId) { ui.layerId = l.id; ui.tab = "text"; }
        break;
      }
      case "delete_text": if (needCard()) { card.layers = card.layers.filter(x => x.id !== a.id); if (ui.layerId === a.id) ui.layerId = null; } break;
      case "photo": if (needCard()) { card.bg.adj = Object.assign({}, ADJ0, card.bg.adj); applyBgSet(card.bg, a.set); if (card.id === ui.cardId && ui.tab === "text" && !ui.layerId) ui.tab = "look"; } break;
      case "reset_photo": if (needCard()) { card.bg.look = "none"; card.bg.lookAmt = 1; card.bg.adj = Object.assign({}, ADJ0); } break;
      case "original_photo": if (needCard() && card.bg.orig) { card.bg.img = card.bg.orig; card.bg.orig = null; card.bg.style = ""; } break;
      case "remove_photo": if (needCard()) { card.bg.img = null; card.bg.orig = null; card.bg.style = ""; } break;
      case "restyle": {
        if (!needCard()) break;
        if (!card.bg.img) { notes.push(`Card ${deck.cards.indexOf(card) + 1} has no photo to restyle.`); break; }
        touch(deck); renderDeck();
        vSay(`<b>“${esc(heard)}”</b> · Restyling card ${deck.cards.indexOf(card) + 1} as ${esc(a.prompt || "")}… this can take 10 to 30 seconds.`);
        try { await restyle(card, String(a.prompt || "painting")); }
        catch (e) { notes.push(aiError(e)); }
        break;
      }
      case "choose_photo": if (needCard()) toast(`Pick a photo for card ${deck.cards.indexOf(card) + 1}.`, { label: "Choose photo", fn: async () => {
        const f = await pickFile("image/*"); if (!f) return; const id = await importImage(f); if (!id) return;
        setPhoto(card, id); touch(deck); renderDeck();
      } }); break;
      case "select":
        if (!needCard()) break;
        ui.cardId = card.id; ui.layerId = card.layers.find(x => x.id === a.id)?.id || null;
        ui.tab = ui.layerId ? "text" : a.id === "photo" ? "photo" : ui.tab; break;
      case "overview": ui.cardId = null; ui.layerId = null; break;
      case "add_cards": {
        const k = clamp(Math.round(+a.count) || 1, 1, 20), t = state.cardTypes.find(x => x.name.toLowerCase() === String(a.type || "").toLowerCase());
        let at = a.after != null ? clamp(Math.round(+a.after) || 0, 0, deck.cards.length) : deck.cards.length;
        for (let i = 0; i < k; i++) deck.cards.splice(at++, 0, t ? cardFromType(t) : newCard([]));
        break;
      }
      case "delete_card": if (card) { deck.cards = deck.cards.filter(c => c !== card); if (ui.cardId === card.id) { ui.cardId = null; ui.layerId = null; } } break;
      case "move_card": if (card) { const to = clamp(Math.round(+a.to) || 1, 1, deck.cards.length) - 1; deck.cards.splice(deck.cards.indexOf(card), 1); deck.cards.splice(to, 0, card); } break;
      case "duplicate_card": if (card) { const c = copyCards([card], true)[0]; deck.cards.splice(deck.cards.indexOf(card) + 1, 0, c); } break;
      case "card_type": {
        const t = state.cardTypes.find(x => x.name.toLowerCase() === String(a.name || "").toLowerCase());
        if (!t) notes.push(`No card type called “${a.name}”.`); else if (needCard()) { useCardType(card, t); if (card.id === ui.cardId) ui.layerId = null; }
        break;
      }
      case "size": if (ASPECTS[a.aspect]) deck.aspect = a.aspect; break;
      case "rename_deck": if (a.name) deck.name = String(a.name).slice(0, 80); break;
      case "export": toast("Your cards are ready to share.", { label: "Share", fn: () => openExport(deck) }); break;
      case "undo": undo(); break;
      case "redo": redo(); break;
    }
  }
  touch(deck);
  return notes;
}
/* Speech: the phone's own recognizer (Chrome on Android, Safari on iPhone). */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
function micFallback(msg) {
  vSay(esc(msg));
  const inp = $("#vinput"); inp.focus();
}
function toggleMic() {
  const btn = $("#micBtn");
  if (rec) { rec.stop(); return; }
  if (!SR) { micFallback("Voice isn't built into this browser. Tap the box and use your keyboard's microphone instead."); return; }
  const inp = $("#vinput");
  rec = new SR(); rec.lang = settings.lang || navigator.language || "en-US"; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
  let finalText = "", failed = false;
  rec.onresult = e => {
    let t = ""; for (let i = 0; i < e.results.length; i++) { t += e.results[i][0].transcript; if (e.results[i].isFinal) finalText = t; }
    inp.value = t;
  };
  rec.onerror = e => {
    failed = true;
    if (e.error === "not-allowed" || e.error === "service-not-allowed") micFallback("The microphone isn't allowed here. Tap the box and use your keyboard's microphone, or allow the mic in your phone's settings.");
    else if (e.error === "no-speech") vSay("Didn't hear anything. Tap the microphone and try again.");
    else if (e.error === "network") micFallback("Voice needs the internet. Tap the box and use your keyboard's microphone.");
    else if (e.error !== "aborted") micFallback("Voice stopped working. Tap the box and use your keyboard's microphone.");
  };
  rec.onend = () => {
    rec = null; btn.classList.remove("live"); btn.setAttribute("aria-label", "Talk");
    const t = (finalText || inp.value).trim();
    if (!failed && t) runCommand(t);
  };
  try { rec.start(); btn.classList.add("live"); btn.setAttribute("aria-label", "Stop listening"); vSay("Listening…"); }
  catch (e) { rec = null; micFallback("Voice couldn't start. Tap the box and use your keyboard's microphone."); }
}
function helpSheet() {
  const ex = (title, list) => h("div", {}, h("h3", {}, title), h("ul", {}, list.map(s => h("li", {}, "“" + s + "”"))));
  sheet("What can I say?", h("div", { class: "say" },
    h("p", { style: "margin:0" }, "Tap the microphone, say what you want, then pause. You can also type in the box. Tap a piece of text first to point at it, or name it (“the title”, “card 3”)."),
    ex("Words", ["Change the text to: Be still and know", "Add text at the bottom that says follow for more", "Put a line break after still"]),
    ex("Text style", ["Make the title bigger and gold", "Use a handwritten font", "Move it to the top", "Put a dark box behind the caption"]),
    ex("Photo", ["Make it black and white", "Warmer and a little brighter", "Add dark edges and film grain", "Zoom in and move the photo up", "Blur the background a lot"]),
    ex("AI styles (need internet)", ["Turn it into a watercolor painting", "Make it look like a pencil drawing", "Back to the original photo"]),
    ex("Cards", ["Add three cards", "Go to card 2", "Move this card to the end", "Delete card 4", "Make every card sepia", "Make it square"]),
    ex("Fixing", ["Undo", "Redo"])));
}

/* ---------- Export ---------- */
async function openExport(deck) {
  const [W, H] = ASPECTS[deck.aspect] || ASPECTS["4:5"];
  const grid = h("div", { class: "exportgrid" });
  const status = h("p", { class: "small muted", role: "status" }, "Making images…");
  const zipBtn = h("button", { class: "btn", disabled: true }, "Save all (.zip)");
  const shareBtn = h("button", { class: "btn primary", disabled: true }, "Share…");
  const driveBtn = (window.Drive && Drive.enabled) ? h("button", { class: "btn", disabled: true, "data-drive": "1" }, "Save to Drive") : null;
  sheet("Share " + deck.name, [status, h("div", { class: "row" }, shareBtn, driveBtn, zipBtn), grid,
    h("p", { class: "small muted" }, "Share opens your phone's share sheet. Pick Instagram or Facebook and the cards go in as one post, in order. You can also press and hold an image to save it to your photos.")]);
  const files = [], base = slug(deck.name);
  for (let i = 0; i < deck.cards.length; i++) {
    const cv = document.createElement("canvas");
    await renderCard(deck.cards[i], cv, W, H, {});
    const b = await new Promise(r => cv.toBlob(r, "image/jpeg", 0.93));
    const name = `${base}-${String(i + 1).padStart(2, "0")}.jpg`;
    files.push([name, b]);
    grid.append(h("figure", {}, h("img", { src: URL.createObjectURL(b), alt: "Card " + (i + 1) }),
      h("figcaption", {}, "Card " + (i + 1), h("button", { class: "btn small", onclick: () => saveFile(name, b) }, "Save"))));
    status.textContent = `Made ${i + 1} of ${deck.cards.length}…`;
  }
  status.textContent = `${deck.cards.length} images ready, ${W}×${H}.` + (deck.cards.length > 20 ? " Instagram takes up to 20 per post." : "");
  zipBtn.disabled = false; shareBtn.disabled = false;
  shareBtn.addEventListener("click", () => shareFiles(files, deck.name));
  if (driveBtn) {
    driveBtn.disabled = false;
    driveBtn.addEventListener("click", async () => {
      if (!Drive.connected) { toast("Connect Google Drive first, in Library."); return; }
      driveBtn.disabled = true; driveBtn.textContent = "Saving to Drive…";
      const ok = await Drive.saveDeck(deck, files);
      driveBtn.disabled = false; driveBtn.textContent = "Save to Drive";
      toast(ok ? `Saved to Worked Up › Decks › ${deck.name} in your Drive.` : "Couldn't save to Drive. Try again.");
    });
  }
  zipBtn.addEventListener("click", async () => {
    if (!window.JSZip) { toast("The zip tool didn't load. Save the images one at a time."); return; }
    const zip = new JSZip(); files.forEach(([n, b]) => zip.file(n, b));
    saveFile(base + ".zip", await zip.generateAsync({ type: "blob" }));
  });
}

/* ---------- Library ---------- */
function renderLibrary() {
  const typeItems = h("div", { class: "items" }), tmplItems = h("div", { class: "items" }), fontItems = h("div", { class: "items" });
  const rename = async (obj, title) => { const nm = await askText(title, obj.name); if (nm) { obj.name = nm; saveSoon(); renderLibrary(); } };
  state.cardTypes.forEach(t => {
    const cv = h("canvas", { "aria-hidden": "true" }); renderCard(t.card, cv, 1080, 1350, { scale: 0.08 });
    typeItems.append(h("div", { class: "item" }, cv, h("div", { class: "grow" }, h("div", { class: "nm" }, t.name), h("div", { class: "small muted" }, `${t.card.layers.length} text piece${t.card.layers.length === 1 ? "" : "s"}`)),
      h("button", { class: "btn small", onclick: () => rename(t, "Rename card type") }, "Rename"),
      h("button", { class: "btn small ghost danger", onclick: async () => { if (await confirmSheet(`Delete card type “${t.name}”?`)) { state.cardTypes = state.cardTypes.filter(x => x !== t); saveSoon(); renderLibrary(); } } }, "Delete")));
  });
  if (!state.cardTypes.length) typeItems.append(h("p", { class: "muted small" }, "None yet. In a deck, use Save as card type."));
  state.templates.forEach(t => {
    const cv = h("canvas", { "aria-hidden": "true" }); if (t.cards[0]) renderCard(t.cards[0], cv, ...(ASPECTS[t.aspect] || ASPECTS["4:5"]), { scale: 0.05 });
    tmplItems.append(h("div", { class: "item" }, cv, h("div", { class: "grow" }, h("div", { class: "nm" }, t.name), h("div", { class: "small muted" }, `${t.cards.length} cards`)),
      h("button", { class: "btn small", onclick: async () => { const nm = await askText("Name this deck", "") || "Untitled"; const d = makeDeck(nm, copyCards(t.cards, false), t.aspect); go("deck", d.id); } }, "Use"),
      h("button", { class: "btn small", onclick: () => rename(t, "Rename template") }, "Rename"),
      h("button", { class: "btn small ghost danger", onclick: async () => { if (await confirmSheet(`Delete template “${t.name}”?`)) { state.templates = state.templates.filter(x => x !== t); saveSoon(); renderLibrary(); } } }, "Delete")));
  });
  if (!state.templates.length) tmplItems.append(h("p", { class: "muted small" }, "None yet. On the Decks page, use More, then Save as template."));
  fontsByUse().forEach(f => {
    fontItems.append(h("div", { class: "item" }, h("div", { class: "grow" },
      h("div", { class: "fontsample", style: `font-family:"${f.family}", Georgia, serif` }, f.family),
      h("div", { class: "small muted" }, `${f.source === "custom" ? "Your file" : "Google Fonts"} · used ${state.usage.fonts[f.family] || 0}×`)),
      h("button", { class: "btn small ghost danger", onclick: async () => {
        if (!await confirmSheet(`Remove ${f.family} from your font list? Cards already using it keep their text, but it may show in a fallback font.`, "Remove")) return;
        state.fonts = state.fonts.filter(x => x !== f); saveSoon(); if (f.blobId) await gcBlob(f.blobId); renderLibrary();
      } }, "Remove")));
  });
  main.replaceChildren(
    h("h2", {}, "Library"),
    aiSection(),
    driveSection(),
    installSection(),
    h("section", { class: "section" }, h("h3", {}, "Card types"), typeItems),
    h("section", { class: "section" }, h("h3", {}, "Templates"), tmplItems),
    h("section", { class: "section" }, h("div", { class: "row between" }, h("h3", {}, "Fonts"),
      h("div", { class: "row" }, h("button", { class: "btn small", onclick: addGoogleFont }, "Add Google font"), h("button", { class: "btn small", onclick: uploadFont }, "Upload font file"),
      (window.Drive && Drive.enabled) ? h("button", { class: "btn small", "data-drive": "1", onclick: async () => { if (!Drive.connected) { toast("Connect Google Drive first."); return; } const files = await Drive.pick({ images: false }); const f = files.find(isFont); if (f) fontFromFile(f); else if (files.length) toast("That isn't a font file (.ttf, .otf, .woff or .woff2)."); } }, "Font from Drive") : null)), fontItems),
    h("section", { class: "section" }, h("h3", {}, "Backup"),
      h("p", { class: "small muted", style: "max-width:62ch;margin:0" }, (window.Drive && Drive.connected) ? "Your work syncs to Google Drive. A backup file is an extra copy you keep yourself." : "Everything is saved on this device. Save a backup now and then, or connect Google Drive above."),
      h("div", { class: "row" }, h("button", { class: "btn primary", onclick: backup }, "Save backup file"), h("button", { class: "btn", onclick: restore }, "Restore from backup")),
      h("p", { class: "small muted", id: "usage-line", style: "margin:0" })));
  if (navigator.storage?.estimate) navigator.storage.estimate().then(e => { const u = $("#usage-line"); if (u && e.usage != null) u.textContent = `Using about ${(e.usage / 1048576).toFixed(1)} MB.`; }).catch(() => {});
}
function aiSection() {
  const key = h("input", { class: "field", id: "gem-key", type: "password", value: settings.geminiKey, autocomplete: "off", placeholder: "Paste the Gemini API key", style: "flex:1;min-width:200px" });
  const line = h("p", { class: "small muted", style: "margin:0" }, settings.geminiKey ? `Key saved on this device.${settings.textModel ? ` Using ${settings.textModel} and ${settings.imageModel}.` : ""}` : "No key yet. Voice changes and AI styles need one.");
  const check = async () => {
    settings.geminiKey = key.value.trim(); settings.textModel = ""; settings.imageModel = ""; saveSettings();
    if (!settings.geminiKey) { line.textContent = "Key removed from this device."; return; }
    line.textContent = "Checking the key…";
    try { const m = await pickModels(); settings.textModel = m.text || "gemini-2.5-flash"; settings.imageModel = m.image || "gemini-3.1-flash-image"; saveSettings(); line.textContent = `Key works. Using ${settings.textModel} for voice and ${settings.imageModel} for AI styles.`; }
    catch (e) { line.textContent = aiError(e); }
    renderAdv();
  };
  const langs = [["", "Phone's language"], ["en-US", "English (US)"], ["en-GB", "English (UK)"], ["en-AU", "English (Australia)"], ["es-US", "Spanish (US)"], ["es-ES", "Spanish (Spain)"], ["fr-FR", "French"], ["de-DE", "German"], ["pt-BR", "Portuguese (Brazil)"]];
  const lang = h("select", { class: "field", id: "voice-lang", style: "width:auto" }, langs.map(([v, t]) => h("option", { value: v }, t)));
  lang.value = settings.lang || ""; lang.addEventListener("change", () => { settings.lang = lang.value; saveSettings(); });
  const adv = h("details", {});
  const renderAdv = () => {
    const t = h("input", { class: "field", id: "m-text", value: settings.textModel }), i = h("input", { class: "field", id: "m-image", value: settings.imageModel });
    t.addEventListener("change", () => { settings.textModel = t.value.trim(); saveSettings(); });
    i.addEventListener("change", () => { settings.imageModel = i.value.trim(); saveSettings(); });
    adv.replaceChildren(h("summary", {}, "Advanced: AI models"), h("div", { class: "grid2", style: "margin-top:8px" },
      h("div", {}, h("label", { class: "lbl", for: "m-text" }, "Voice model"), t), h("div", {}, h("label", { class: "lbl", for: "m-image" }, "Image model"), i)),
      h("p", { class: "small muted", style: "margin:6px 0 0" }, "Check key fills these in with the newest models your key can use. Leave them alone unless something stops working."));
  };
  renderAdv();
  return h("section", { class: "section" }, h("h3", {}, "Voice and AI"),
    h("p", { class: "small muted", style: "margin:0;max-width:62ch" }, "Voice changes and AI styles use Google Gemini. The key stays on this device only. It isn't synced or put in backups, so enter it once on each phone."),
    h("div", { class: "row" }, key, h("button", { class: "btn small", onclick: () => { key.type = key.type === "password" ? "text" : "password"; } }, "Show"), h("button", { class: "btn primary", onclick: check }, "Check key")),
    line,
    h("div", { class: "row" }, h("label", { class: "lbl", for: "voice-lang", style: "margin:0" }, "Voice language"), lang),
    adv);
}
function driveSection() {
  if (!window.Drive || !Drive.enabled) return h("section", { class: "section" }, h("h3", {}, "Google Drive"),
    h("p", { class: "small muted", style: "margin:0;max-width:62ch" }, "Drive sync isn't set up yet. The Google keys go in config.js (see the README)."));
  const line = h("p", { class: "small muted", style: "margin:0" });
  const paint = () => { line.textContent = Drive.connected ? `Connected${Drive.email ? " as " + Drive.email : ""}. ${Drive.message}` : "Not connected."; };
  paint(); Drive.onStatus(() => { if (line.isConnected) paint(); });
  return h("section", { class: "section" }, h("h3", {}, "Google Drive"),
    h("p", { class: "small muted", style: "margin:0;max-width:62ch" }, "Syncs your decks, photos and fonts to a Worked Up folder in your Drive, so both phones stay the same. The app can only see files it made and files you pick."),
    line,
    Drive.connected
      ? h("div", { class: "row" }, h("button", { class: "btn primary", "data-drive": "1", onclick: () => Drive.syncNow() }, "Sync now"),
          h("button", { class: "btn ghost danger", "data-drive": "1", onclick: async () => { if (await confirmSheet("Stop syncing on this device? Your files stay in Drive.", "Disconnect")) { await Drive.disconnect(); renderLibrary(); } } }, "Disconnect"))
      : h("div", { class: "row" }, h("button", { class: "btn primary", "data-drive": "1", onclick: () => Drive.connect() }, "Connect Google Drive")));
}
let installEvt = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; if (ui.screen === "library") renderLibrary(); });
function installSection() {
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  if (standalone) return null;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  return h("section", { class: "section" }, h("h3", {}, "Put it on your home screen"),
    installEvt ? h("div", { class: "row" }, h("button", { class: "btn primary", onclick: async () => { installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; renderLibrary(); } }, "Install app"))
      : h("p", { class: "small muted", style: "margin:0;max-width:62ch" }, ios ? "In Safari, tap the Share button, then Add to Home Screen." : "In your browser menu, choose Install app or Add to Home screen."));
}
async function addGoogleFont() {
  const name = await askText("Google font name (as shown on fonts.google.com)", "", "Add"); if (!name) return;
  const fam = await tryGoogleFont(name);
  if (!fam) { toast(`Couldn't find “${name}” on Google Fonts. Check the spelling.`); return; }
  renderLibrary(); toast(`${fam} is in your fonts.`);
}
async function uploadFont() {
  const f = await pickFile(".ttf,.otf,.woff,.woff2"); if (f) fontFromFile(f);
}
async function backup() {
  if (!window.JSZip) { toast("The backup tool didn't load. Reload the page and try again."); return; }
  const zip = new JSZip();
  zip.file("state.json", JSON.stringify(state));
  for (const id of blobRefs()) { const b = await DB.get("blobs", id); if (b) zip.file("blobs/" + id, b); }
  const d = new Date(), stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (await saveFile(`worked-up-backup-${stamp}.zip`, await zip.generateAsync({ type: "blob" }))) toast("Backup saved.");
}
async function restore() {
  if (!window.JSZip) { toast("The backup tool didn't load. Reload the page and try again."); return; }
  const f = await pickFile(".zip"); if (!f) return;
  let zip, s;
  try { zip = await JSZip.loadAsync(f); s = JSON.parse(await zip.file("state.json").async("string")); if (!s || !Array.isArray(s.decks)) throw 0; }
  catch (e) { toast("That file isn't a Worked Up backup."); return; }
  if (!await confirmSheet("Restoring replaces everything in the app with the backup. Continue?", "Restore")) return;
  await DB.clear("blobs"); blobCache.clear(); bgCache.clear();
  for (const name of Object.keys(zip.files)) {
    if (!name.startsWith("blobs/") || zip.files[name].dir) continue;
    await DB.put("blobs", name.slice(6), await zip.file(name).async("blob"));
  }
  state = normalize(s); await saveNow(); loadAllFonts(); Object.assign(hist, { deckId: null }); go("decks"); toast("Backup restored.");
}
function normalize(s) {
  s.usage = s.usage || { fonts: {}, colors: [] };
  s.cardTypes = s.cardTypes || []; s.templates = s.templates || []; s.fonts = s.fonts || [];
  const fix = c => { c.bg = newBg(c.bg); };
  s.decks.forEach(d => d.cards.forEach(fix)); s.templates.forEach(t => t.cards.forEach(fix)); s.cardTypes.forEach(t => fix(t.card));
  return s;
}
async function replaceState(s) {
  state = normalize(s); bgCache.clear();
  clearTimeout(saveTimer); await DB.put("kv", "state", state).catch(() => {});
  loadAllFonts();
  const d = curDeck(); if (d) histReset(d);
  if (ui.screen === "deck" && !d) go("decks"); else go(ui.screen === "deck" ? "deck" : ui.screen, ui.deckId);
  toast("Updated from Google Drive.");
}
function conflictChoice() {
  return choose("Changes in two places", [
    { label: "Use the Drive version", sub: "Replace what's on this device with what's in Drive", value: "drive" },
    { label: "Keep this device's version", sub: "Replace what's in Drive with what's here", value: "device" }
  ], h("p", { class: "small", style: "margin:0" }, "This device and your Drive both changed since the last sync.")).then(v => v || "device");
}
function firstConnectChoice() {
  return choose("You already have Worked Up in Drive", [
    { label: "Use what's in Drive", sub: "Best when you've used the app on another phone", value: "drive" },
    { label: "Use what's on this device", sub: "Replaces what's in Drive", value: "device" }
  ]).then(v => v || "drive");
}
/* Drop files anywhere: a photo becomes the card's background in the editor, or new cards on the overview. Fonts get added. */
document.addEventListener("dragover", e => { if ([...(e.dataTransfer?.types || [])].includes("Files")) e.preventDefault(); });
document.addEventListener("drop", async e => {
  const files = [...(e.dataTransfer?.files || [])]; if (!files.length) return;
  e.preventDefault();
  const fonts = files.filter(isFont), imgs = files.filter(f => f.type.startsWith("image/"));
  for (const f of fonts) await fontFromFile(f);
  if (!imgs.length || ui.screen !== "deck") return;
  if (curCard()) { const id = await importImage(imgs[0]); if (!id) return; setPhoto(curCard(), id); changed(); renderPanel(); }
  else addPhotoCards(imgs);
});
/* Paste a photo while editing a card to use it as the background. */
document.addEventListener("paste", async e => {
  if (ui.screen !== "deck" || !curCard()) return;
  if (e.target.closest && e.target.closest("input,textarea")) return;
  const f = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith("image/")); if (!f) return;
  e.preventDefault(); const id = await importImage(f); if (!id) return;
  setPhoto(curCard(), id); changed(); renderPanel();
});

/* ---------- boot ---------- */
(async function boot() {
  await DB.open();
  let s = null;
  if (!DB.mem) { try { s = await DB.get("kv", "state"); } catch (e) {} try { Object.assign(settings, (await DB.get("kv", "settings")) || {}); } catch (e) {} }
  state = s ? normalize(s) : seed();
  if (!s) saveNow();
  else if (!DB.mem) { try { const keep = blobRefs(); for (const k of await DB.keys("blobs")) if (!keep.has(k)) await DB.del("blobs", k); } catch (e) {} }
  if (DB.mem) $("#banner").replaceChildren(h("div", { class: "banner" }, "This browser isn't letting the app save. Anything you make will be lost when you close the page. A private window can cause this."));
  $("#storeNote").textContent = DB.mem ? "Not saving" : "";
  loadAllFonts();
  try { navigator.storage?.persist?.().catch(() => {}); } catch (e) {}
  $("#micBtn").addEventListener("click", toggleMic);
  $("#vform").addEventListener("submit", e => { e.preventDefault(); runCommand($("#vinput").value); });
  $("#undoBtn").addEventListener("click", () => { if (undo()) vSay("Undone."); });
  $("#redoBtn").addEventListener("click", () => { if (redo()) vSay("Redone."); });
  $("#helpBtn").addEventListener("click", helpSheet);
  go("decks");
  if (window.Drive) {
    await Drive.init({ getState: () => state, replaceState, blobRefs, conflict: conflictChoice, firstConnect: firstConnectChoice, toast });
    const chip = $("#syncChip");
    if (Drive.enabled) Drive.onStatus((st, msg) => {
      chip.hidden = st === "off";
      chip.textContent = { connecting: "Connecting…", syncing: "Syncing…", synced: "Synced", paused: "Tap to sync", error: "Sync problem", offline: "Offline" }[st] || "";
      chip.title = msg; chip.dataset.state = st;
    });
    chip.addEventListener("click", () => { if (Drive.status === "paused" || Drive.status === "error") Drive.reconnect(); else go("library"); });
  }
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("./sw.js").catch(() => {});
})();
