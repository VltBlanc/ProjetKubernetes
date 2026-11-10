import { useEffect, useRef } from "react";

// Vue 3D de l'univers, dessinée à la main sur un <canvas> (aucune dépendance).
//   glisser : tourner · Maj + glisser (ou clic droit) : déplacer · molette : zoomer ·
//   double-clic : revenir à la vue de départ · clic sur une galaxie : tirer une particule ·
//   Alt + clic : y envoyer des particules.
// Chaque galaxie : {slot, status, model, pos: [x0, y0, z0, x1, …], com: [x, y, z]}.
// colorOf(g) donne sa couleur, label(g) ses deux lignes d'étiquette.
// Animation fluide : les états arrivent par à-coups (un pas, puis un autre…) ; entre deux états
// reçus, la vue fait glisser chaque corps de l'ancienne à la nouvelle position, à 60 images/s.

const START = { yaw: -0.35, pitch: 0.75, zoom: 1, panX: 0, panY: 0 };
const SPACING = 12; // distance entre deux cases de l'univers (comme la gateway)

// onPick(galaxie, alt) : clic court (sans glisser) sur une galaxie ; alt = touche Alt enfoncée.
export default function View3D({ galaxies, colorOf, label, onPick, size = 720 }) {
  const canvas = useRef(null);
  const cam = useRef({ ...START });
  const props = useRef({ galaxies, colorOf, label, onPick });
  const flashes = useRef(new Map()); // id de galaxie → {t, alt} : le dernier clic, pour l'animer
  const hits = useRef([]); // centre de chaque galaxie à l'écran, pour savoir laquelle on a cliquée
  const dirty = useRef(true);
  const anim = useRef(new Map()); // id de galaxie → {from, to, t0, dur, step, at}
  const lastData = useRef(null);
  props.current = { galaxies, colorOf, label, onPick };
  dirty.current = true; // nouvel univers (ou nouvelles couleurs) : on redessine à la prochaine image
  if (galaxies !== lastData.current) { lastData.current = galaxies; retarget(anim.current, galaxies); }

  useEffect(() => {
    const el = canvas.current;
    const ctx = el.getContext("2d");
    let raf;
    const frame = () => {
      const now = performance.now();
      let moving = false;
      for (const a of anim.current.values()) if (now < a.t0 + a.dur) { moving = true; break; }
      for (const fl of flashes.current.values()) if (now - fl.t < 600) { moving = true; break; }
      if (dirty.current || moving) { dirty.current = false; draw(ctx, props.current, cam.current, size, anim.current, now, hits.current, flashes.current); }
      raf = requestAnimationFrame(frame);
    };
    frame();

    // souris : tourner, déplacer, zoomer
    let drag = null, pending = null;
    const scale = () => size / el.getBoundingClientRect().width; // pixels du canvas par pixel écran
    const down = (e) => { drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, pan: e.shiftKey || e.button === 2 }; el.setPointerCapture(e.pointerId); };
    const move = (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      const c = cam.current;
      if (drag.pan) { c.panX += dx * scale(); c.panY += dy * scale(); }
      else {
        c.yaw += dx * 0.008;
        c.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, c.pitch + dy * 0.008));
      }
      dirty.current = true;
    };
    const up = (e) => {
      // un clic court, sans glisser, sur une galaxie : on interagit avec elle
      const d = drag;
      drag = null;
      if (!d || d.pan || Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > 4 || !props.current.onPick) return;
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) * scale(), y = (e.clientY - r.top) * scale();
      let best = null, bestD = 70; // à moins de 70 pixels du centre d'une galaxie
      for (const h of hits.current) { const dd = Math.hypot(h.x - x, h.y - y); if (dd < bestD) { bestD = dd; best = h; } }
      const g = best && props.current.galaxies.find((x) => x.id === best.id);
      // attendre un peu : un double-clic (retour à la vue de départ) ne doit pas tirer deux fois
      const alt = e.altKey;
      clearTimeout(pending);
      if (g) pending = setTimeout(() => { flashes.current.set(g.id, { t: performance.now(), alt }); props.current.onPick(g, alt); }, 260);
    };
    const wheel = (e) => {
      e.preventDefault();
      cam.current.zoom = Math.max(0.2, Math.min(20, cam.current.zoom * Math.exp(-e.deltaY * 0.0015)));
      dirty.current = true;
    };
    const reset = () => { clearTimeout(pending); cam.current = { ...START }; dirty.current = true; };
    const noMenu = (e) => e.preventDefault();
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", () => { drag = null; });
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("dblclick", reset);
    el.addEventListener("contextmenu", noMenu);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("dblclick", reset);
      el.removeEventListener("contextmenu", noMenu);
    };
  }, [size]);

  return (
    <div className="frame">
      <canvas ref={canvas} width={size} height={size} />
      <p className="hint"><strong>clic</strong> sur une galaxie : tirer une particule · <strong>Alt + clic</strong> : y envoyer 50 particules · glisser : tourner · Maj + glisser : déplacer · molette : zoom · double-clic : vue de départ</p>
    </div>
  );
}

// Un nouvel état pour une galaxie : on part de la position affichée en ce moment et on glisse vers
// la nouvelle, sur la durée qui a séparé les deux derniers états (l'animation a donc un temps de retard,
// mais ne s'arrête jamais entre deux mises à jour).
function retarget(map, galaxies) {
  const now = performance.now();
  const seen = new Set();
  for (const g of galaxies) {
    seen.add(g.id);
    const a = map.get(g.id);
    if (!a || a.to.length !== g.pos.length) {
      map.set(g.id, { from: g.pos, to: g.pos, t0: now, dur: 0, step: g.step, at: now });
      continue;
    }
    if (g.step === a.step) continue; // même pas (sondage plus rapide que le worker) : on laisse glisser
    const k = a.dur > 0 ? Math.min(1, (now - a.t0) / a.dur) : 1;
    const from = k >= 1 ? a.to : a.from.map((v, i) => v + (a.to[i] - v) * k);
    const dur = g.step > a.step ? Math.min(1000, Math.max(60, now - a.at)) : 0; // retour en arrière : saut
    map.set(g.id, { from, to: g.pos, t0: now, dur, step: g.step, at: now });
  }
  for (const id of map.keys()) if (!seen.has(id)) map.delete(id);
}

// Les masses centrales, dessinées plus grosses.
const heavy = (g, i, n) => (["disque", "elliptique", "anneau"].includes(g.model) && i === 0)
  || (g.model === "collision" && (i === 0 || i === Math.floor(n / 2)));

function draw(ctx, { galaxies, colorOf, label }, c, size, anim, now, hits = [], flashes = new Map()) {
  hits.length = 0;
  ctx.fillStyle = "#0b0b12";
  ctx.fillRect(0, 0, size, size);
  if (!galaxies.length) {
    ctx.fillStyle = "#666";
    ctx.font = "14px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("univers vide : ajoutez une galaxie depuis le catalogue", size / 2, size / 2);
    return;
  }
  // Cadrage : une sphère qui contient toutes les CASES des galaxies (centre fixe de la case + 5,5
  // de rayon). On cadre sur les cases et non sur les corps ou le centre de masse : ceux-ci bougent à
  // chaque pas (corps éjectés, tirs), et la vue tremblerait sans arrêt.
  const centre = (g) => g.com ?? [g.pos[0] ?? 0, g.pos[1] ?? 0, g.pos[2] ?? 0];
  const box = (g) => g.center ?? centre(g);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const g of galaxies) {
    const [x, y] = box(g);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const ox = (x0 + x1) / 2, oy = (y0 + y1) / 2;
  let half = 0;
  for (const g of galaxies) {
    const [x, y, z] = box(g);
    half = Math.max(half, Math.hypot(x - ox, y - oy, z));
  }
  half += 5.5;
  const k = (size / (2 * half)) * c.zoom; // pixels par unité de longueur
  const D = 4 * half; // distance de la caméra au centre : une perspective douce
  const cosY = Math.cos(c.yaw), sinY = Math.sin(c.yaw), cosP = Math.cos(c.pitch), sinP = Math.sin(c.pitch);

  // monde → écran : rotation autour de z (yaw), puis autour de x (pitch), puis perspective.
  // Rend [x écran, y écran, profondeur (> 0 = vers nous), facteur de perspective].
  const project = (x, y, z) => {
    const dx = x - ox, dy = y - oy;
    const xr = dx * cosY - dy * sinY;
    const yr = dx * sinY + dy * cosY;
    const yv = yr * cosP - z * sinP;
    const zv = yr * sinP + z * cosP;
    const f = D / Math.max(D * 0.1, D - zv);
    return [size / 2 + c.panX + xr * k * f, size / 2 + c.panY - yv * k * f, zv, f];
  };

  // Le plan des cases (z = 0), en grille légère : il donne le relief.
  ctx.strokeStyle = "#1d1d2b";
  ctx.lineWidth = 1;
  const gx0 = Math.floor((ox - half) / SPACING) * SPACING - SPACING / 2;
  const gy0 = Math.floor((oy - half) / SPACING) * SPACING - SPACING / 2;
  const gx1 = ox + half + SPACING, gy1 = oy + half + SPACING;
  ctx.beginPath();
  for (let x = gx0; x <= gx1; x += SPACING) {
    const [a, b] = project(x, gy0, 0), [e, f] = project(x, gy1, 0);
    ctx.moveTo(a, b); ctx.lineTo(e, f);
  }
  for (let y = gy0; y <= gy1; y += SPACING) {
    const [a, b] = project(gx0, y, 0), [e, f] = project(gx1, y, 0);
    ctx.moveTo(a, b); ctx.lineTo(e, f);
  }
  ctx.stroke();

  // Les galaxies, de la plus lointaine à la plus proche.
  const order = galaxies.map((g) => ({ g, depth: project(...box(g))[2] })).sort((a, b) => a.depth - b.depth);
  ctx.font = "11px ui-monospace, monospace";
  ctx.textAlign = "center";
  for (const { g } of order) {
    const color = colorOf(g);
    ctx.fillStyle = color;
    ctx.globalAlpha = g.status === "finished" || g.status === "paused" ? 0.45 : 1;
    const a = anim.get(g.id);
    const u = a && a.dur > 0 ? Math.min(1, (now - a.t0) / a.dur) : 1; // avancement de l'animation
    const to = a ? a.to : g.pos, from = a ? a.from : g.pos;
    const at = (j) => (u >= 1 ? to[j] : from[j] + (to[j] - from[j]) * u); // position interpolée
    const n = to.length / 3;
    for (let i = 0; i < n; i++) {
      const [x, y, , f] = project(at(3 * i), at(3 * i + 1), at(3 * i + 2));
      if (x < -2 || y < -2 || x > size + 2 || y > size + 2) continue;
      const r = (heavy(g, i, n) ? 3.6 : 1.5) * Math.min(2, f);
      ctx.fillRect(x - r / 2, y - r / 2, r, r);
    }
    ctx.globalAlpha = 1;
    const [cx, cy, , f] = project(...box(g));
    hits.push({ id: g.id, x: cx, y: cy });
    // retour visuel d'un clic : un anneau qui s'élargit et s'efface
    const fl = flashes.get(g.id);
    if (fl && now - fl.t < 600) {
      const u = (now - fl.t) / 600;
      ctx.globalAlpha = 1 - u;
      ctx.strokeStyle = fl.alt ? "#7dd3fc" : "#fbbf24";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, (1 + 3 * u) * Math.max(8, 1.5 * k * f), 0, 2 * Math.PI);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (n === 0) { // pas encore de corps (galaxie en erreur)
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(4, 2 * k * f), 0, 2 * Math.PI);
      ctx.stroke();
    }
    const [l1, l2] = label(g);
    const ty = cy - Math.max(18, 4 * k * f);
    ctx.fillStyle = color;
    ctx.fillText(l1, cx, ty - 13);
    ctx.fillText(l2, cx, ty);
  }
}
