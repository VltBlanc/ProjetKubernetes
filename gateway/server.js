// gateway — la seule API publique de nbody (préfixe /api), tout en HTTP/REST (JSON).
// Sans état : tout est rangé dans le store. On peut donc en lancer plusieurs.
//
// nbody simule un univers de GALAXIES. Chaque galaxie est un ensemble de corps qui s'attirent
// (gravitation, G = 1), placée dans sa propre case de l'espace. Le navigateur crée les galaxies ;
// chaque WORKER en adopte une, la simule pas à pas et rend chaque nouvel état à la gateway.
// N workers = N galaxies qui avancent en même temps ; les autres attendent un worker libre.
// Un worker qui ne donne plus de nouvelles perd sa galaxie au bout de LEASE_MS : un autre worker
// la reprend là où elle en était, puisque son état est dans le store.
//
// La gateway crée l'état initial (pas 0) de chaque galaxie, quel que soit son modèle : disque,
// elliptique, anneau, collision, random (boule au repos), plummer (amas à l'équilibre) ou
// double-spirale (bulbe + deux bras). Les workers ne font que la simuler.
//
// Pour le navigateur :
//   GET    /api/health              → 200 {status, store, pod} | 503 si le store est injoignable
//   GET    /api/stats               → 200 {galaxies, running, waiting, finished, error, paused, workers, langs, pod}
//                                      langs : {<langage>: {running, workers, msPerStep}} — msPerStep = temps
//                                      de CALCUL moyen d'un pas (sans STEP_DELAY_MS), pour comparer les langages
//   GET    /api/galaxies            → 200 [{id, slot, center, n, steps, model, step, t, worker, lang, status, com[, error]}]
//                                      status : running | waiting | finished | error
//   POST   /api/galaxies            → 201 {id, slot, center}   corps : {n, steps, dt, eps, model, seed, radius, tilt, spin, name}
//                                      model : disque | elliptique | anneau | collision | random | plummer | double-spirale
//                                              | double-spirale ; 50 ≤ n ≤ 20000
//   POST   /api/galaxies/:id/pause  → 204 (arrête la simulation : le worker la lâche, elle reste figée)
//   POST   /api/galaxies/:id/resume → 204 (la galaxie redevient libre : un worker la reprend où elle en était)
//   DELETE /api/galaxies/:id        → 204
//   DELETE /api/galaxies            → 204 (tout l'univers)
//   GET    /api/workers             → 200 [{name, lang, status: busy|idle, galaxy, slot}]  (workers vivants)
//   GET    /api/universe            → 200 {galaxies: [… + pos], pod}   (ce que dessine le front)
//   POST   /api/galaxies/:id/interactions → 202 {id, type, bodies}   INTERAGIR avec une galaxie :
//                                      corps : {type: "particules", count?}  nuage de count corps (1–500, 50)
//                                              qui arrive du bord vers le centre de la galaxie ;
//                                              {type: "tir", speed?, mass?}  UN corps lourd lancé de loin
//                                              à grande vitesse (speed 0,1–10, 2 ; mass 0,001–5, 0,3).
//                                      La gateway fabrique les corps mais NE TOUCHE PAS à l'état : elle
//                                      dépose l'interaction dans la file de la galaxie (dans le store).
//                                      404 galaxie inconnue | 409 galaxie finie ou en erreur | 400
// Pour les workers :
//   POST   /api/galaxies/claim      → 200 {galaxy, state} une galaxie à simuler | 204 aucune de libre
//   PUT    /api/galaxies/:id/state  → 204 | 409 galaxie perdue | 404 supprimée | 400 mauvais pas
//                                      corps : {worker, lang, ms, step, t, pos, vel[, mass]}
//                                      mass : obligatoire dès que le nombre de corps a changé (interactions) ;
//                                      pos et vel : 3 × (nombre de masses) nombres. Le n de la galaxie suit.
//   POST   /api/galaxies/:id/release→ 204 (le worker s'arrête : la galaxie est libre tout de suite)
//   POST   /api/galaxies/:id/error  → 204 (cas anormal : le worker ne sait pas la simuler)   corps : {worker, lang, error}
//   GET    /api/galaxies/field      → 200 [{id, com, mass}]   (pour INTERACTIONS=1 dans les workers)
//   GET    /api/galaxies/:id/interactions?worker=<nom> → 200 [{id, type, pos, vel, mass}] les interactions
//                                      en attente (la file est vidée) | 409 si <nom> ne tient pas le bail.
//                                      À appeler AVANT chaque pas : le worker ajoute ces corps à sa galaxie
//                                      (pos, vel, mass concaténés), puis joint `mass` au PUT …/state suivant.
// Supervision :
//   GET    /metrics                 → métriques Prometheus (format texte)
import express from "express";
import crypto from "node:crypto";
import os from "node:os";
import client from "prom-client";

const PORT = Number(process.env.PORT );
const STORE_URL = process.env.STORE_URL ;
// Sans nouvelles d'un worker depuis ce délai (pod tué, nœud perdu…), sa galaxie redevient libre.
const LEASE_MS = Number(process.env.LEASE_MS );
const MAX_N = 20000;
const MODELS = ["disque", "elliptique", "anneau", "collision", "random", "plummer", "double-spirale"];
const SPACING = 12; // distance entre deux cases de l'univers
const POD = os.hostname();
// Un worker sans galaxie redemande du travail toutes les POLL_MS (1 s) : sans nouvelles depuis
// WORKER_TTL_MS, on le considère parti.
const WORKER_TTL_MS = Number(process.env.WORKER_TTL_MS ?? 10000);

async function store(method, path, body) {
  const res = await fetch(`${STORE_URL}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204 || res.status === 404) return { status: res.status, body: null };
  if (!res.ok && res.status !== 409) throw new Error(`store ${method} ${path} → ${res.status}`);
  return { status: res.status, body: res.status === 201 && !res.headers.get("content-type")?.includes("json") ? null : await res.json() };
}

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
const r5 = (x) => Math.round(x * 1e5) / 1e5;
const r2 = (x) => Math.round(x * 100) / 100;
const getDoc = async (col, id) => (await store("GET", `/docs/${col}/${encodeURIComponent(id)}`)).body;
const listIds = async (col) => (await store("GET", `/docs/${col}`)).body?.ids ?? [];
const leases = async () => (await store("GET", "/leases")).body?.leases ?? {};

// --- métriques Prometheus ----------------------------------------------------------------------
client.collectDefaultMetrics({ prefix: "nbody_gateway_" });
const httpRequests = new client.Counter({
  name: "nbody_http_requests_total", help: "Requêtes HTTP reçues par la gateway",
  labelNames: ["method", "route", "code"],
});
const galaxiesCreated = new client.Counter({ name: "nbody_galaxies_created_total", help: "Galaxies créées par cette gateway" });
const interactionsDone = new client.Counter({ name: "nbody_interactions_total", help: "Interactions déposées par les utilisateurs", labelNames: ["type"] });
const stepsDone = new client.Counter({ name: "nbody_steps_total", help: "Pas rendus par les workers à cette gateway", labelNames: ["lang"] });
new client.Gauge({
  name: "nbody_galaxies", help: "Galaxies de l'univers, par statut", labelNames: ["status"],
  async collect() {
    const gs = await allGalaxies().catch(() => null);
    for (const st of ["running", "waiting", "paused", "finished", "error"]) {
      this.set({ status: st }, gs ? gs.filter((g) => g.status === st).length : -1);
    }
  },
});
new client.Gauge({
  name: "nbody_queue_length", help: "Galaxies qui attendent un worker (la charge)",
  async collect() {
    const gs = await allGalaxies().catch(() => null);
    this.set(gs ? gs.filter((g) => g.status === "waiting").length : -1);
  },
});

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use((req, res, next) => {
  res.on("finish", () => {
    const route = req.route?.path ?? (req.path.startsWith("/api") ? "autre" : req.path);
    httpRequests.inc({ method: req.method, route, code: res.statusCode });
  });
  next();
});

// --- état initial d'une galaxie ---------------------------------------------------------------

// Générateur pseudo-aléatoire déterministe : même graine, même galaxie.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gauss = (rnd) => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());

// --- état initial d'une galaxie : les modèles fabriqués par la gateway, tous en 3D ---------------
// Chaque modèle donne des corps {p, v, m} autour du centre de la case ; G = 1.
//   disque     : masse centrale + disque épais de corps en orbite (rayon, inclinaison, sens) ;
//   elliptique : masse centrale + nuage aplati d'orbites circulaires dans des plans au hasard ;
//   anneau     : masse centrale + tore de corps en orbite ;
//   collision  : deux disques qui tombent l'un vers l'autre (le second incliné de 60°) ;
//   random     : boule uniforme d'étoiles au repos (effondrement froid) ;
//   plummer    : amas de Plummer à l'équilibre (vitesses tirées selon Aarseth, Hénon et Wielen 1974) ;
//   double-spirale : bulbe + deux bras spiraux (doubleSpiral()).
const MASS_DISK = 0.05; // masse des petits corps d'une galaxie à masse centrale, contre 1 au centre

const unit = (rnd) => { // direction uniforme sur la sphère
  const z = 2 * rnd() - 1, phi = 2 * Math.PI * rnd(), s = Math.sqrt(1 - z * z);
  return [s * Math.cos(phi), s * Math.sin(phi), z];
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normed = (a) => { const l = Math.hypot(...a) || 1; return a.map((x) => x / l); };
const tilted = ([x, y, z], deg) => { // rotation de deg degrés autour de l'axe x
  if (!deg) return [x, y, z];
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [x, y * c - z * s, y * s + z * c];
};
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

// Un disque : masse centrale M, puis n − 1 corps en orbite quasi circulaire entre 0,3 et R.
function diskBodies(rnd, out, n, R, M, spin, deg = 0, at = [0, 0, 0], vat = [0, 0, 0]) {
  out.push({ p: at, v: vat, m: M });
  for (let i = 1; i < n; i++) {
    const r = 0.3 + (R - 0.3) * Math.sqrt(rnd());
    const th = 2 * Math.PI * rnd();
    const inner = M * (1 + (MASS_DISK * (r * r - 0.09)) / (R * R - 0.09));
    const v = spin * Math.sqrt(inner / r) * (1 + 0.03 * gauss(rnd));
    const p = [r * Math.cos(th), r * Math.sin(th), 0.04 * R * gauss(rnd)];
    out.push({ p: add(at, tilted(p, deg)), v: add(vat, tilted([-v * Math.sin(th), v * Math.cos(th), 0], deg)), m: (M * MASS_DISK) / (n - 1) });
  }
}

// Une galaxie spirale à DEUX BRAS (modèle « double-spirale »).
// Ajoute n corps {p, v, m} dans `out`, autour de l'origine (la gateway les place ensuite dans la case
// et applique l'inclinaison).
// Masse centrale 1 ; 20 % des corps dans un bulbe (orbites circulaires dans des plans au
// hasard, rayon entre 0,3 et 0,25 R) ; les autres sur deux bras en spirale logarithmique
// θ = θ_bras − spin · ln(r / r0) / tan(pitch), bras à 0 et π, pitch = 20°, dispersion de 0,25 rad :
// les bras « traînent » derrière la rotation. Vitesse circulaire, comme diskBodies.
function doubleSpiral(rnd, out, n, R, spin) {
  out.push({ p: [0, 0, 0], v: [0, 0, 0], m: 1 });
  const m = MASS_DISK / (n - 1);
  const nb = Math.floor(0.2 * (n - 1)), rb = 0.25 * R;
  const vcirc = (r) => Math.sqrt((1 + (MASS_DISK * Math.min(1, r / R))) / r);
  for (let i = 0; i < nb; i++) {
    const u = unit(rnd), r = 0.3 + (rb - 0.3) * Math.cbrt(rnd());
    const p = [r * u[0], r * u[1], 0.6 * r * u[2]];
    const d = normed(cross(normed(p), unit(rnd)));
    const v = vcirc(Math.hypot(...p));
    out.push({ p, v: d.map((x) => x * v), m });
  }
  const r0 = rb, k = 1 / Math.tan((20 * Math.PI) / 180);
  for (let i = nb; i < n - 1; i++) {
    const arm = i % 2;
    const r = r0 + (R - r0) * rnd();
    const th = arm * Math.PI - spin * k * Math.log(r / r0) + 0.25 * gauss(rnd);
    const v = spin * vcirc(r) * (1 + 0.03 * gauss(rnd));
    out.push({
      p: [r * Math.cos(th), r * Math.sin(th), 0.04 * R * gauss(rnd)],
      v: [-v * Math.sin(th), v * Math.cos(th), 0], m,
    });
  }
}

function initial(g) {
  const rnd = mulberry32(g.seed);
  const R = g.radius ?? 3, spin = g.spin ?? 1, n = g.n;
  const b = [];
  if (g.model === "disque") diskBodies(rnd, b, n, R, 1, spin);
  else if (g.model === "elliptique") {
    b.push({ p: [0, 0, 0], v: [0, 0, 0], m: 1 });
    for (let i = 1; i < n; i++) {
      const r = 0.3 + (R - 0.3) * rnd();
      const u = unit(rnd);
      const p = [r * u[0], r * u[1], 0.6 * r * u[2]]; // aplatie : une elliptique E4
      const v = spin * Math.sqrt((1 + (MASS_DISK * (r - 0.3)) / (R - 0.3)) / Math.hypot(...p));
      const d = normed(cross(normed(p), unit(rnd))); // orbite circulaire dans un plan au hasard
      b.push({ p, v: d.map((x) => x * v), m: MASS_DISK / (n - 1) });
    }
  } else if (g.model === "anneau") {
    b.push({ p: [0, 0, 0], v: [0, 0, 0], m: 1 });
    for (let i = 1; i < n; i++) {
      const th = 2 * Math.PI * rnd();
      const r = R * (0.85 + 0.06 * gauss(rnd));
      const v = spin * Math.sqrt(1 / r);
      b.push({ p: [r * Math.cos(th), r * Math.sin(th), 0.06 * R * gauss(rnd)], v: [-v * Math.sin(th), v * Math.cos(th), 0], m: MASS_DISK / (n - 1) });
    }
  } else if (g.model === "collision") {
    const h = Math.floor(n / 2), d = 1.2 * R;
    diskBodies(rnd, b, h, R / 2, 0.5, spin, 0, [-d, -0.4 * R, 0], [0.08, 0.12, 0]);
    diskBodies(rnd, b, n - h, R / 2, 0.5, spin, 60, [d, 0.4 * R, 0], [-0.08, -0.12, 0]);
  } else if (g.model === "random") {
    for (let i = 0; i < n; i++) {
      const u = unit(rnd), r = R * Math.cbrt(rnd());
      b.push({ p: u.map((x) => x * r), v: [0, 0, 0], m: 1 / n });
    }
  } else if (g.model === "double-spirale") {
    doubleSpiral(rnd, b, n, R, spin);
  } else if (g.model === "plummer") {
    const a = R / 4;
    for (let i = 0; i < n; i++) {
      let r;
      do r = a / Math.sqrt(rnd() ** (-2 / 3) - 1); while (!(r < 2 * R));
      let q, y;
      do { q = rnd(); y = 0.1 * rnd(); } while (y > q * q * (1 - q * q) ** 3.5);
      const ve = Math.SQRT2 * (1 + (r * r) / (a * a)) ** -0.25 / Math.sqrt(a);
      const u = unit(rnd), w = unit(rnd);
      b.push({ p: u.map((x) => x * r), v: w.map((x) => x * q * ve), m: 1 / n });
    }
  }
  // inclinaison de toute la galaxie (les amas sphériques n'en ont pas besoin), puis centrage sur la case
  const deg = g.model === "random" || g.model === "plummer" ? 0 : g.tilt ?? 0;
  const pos = [], vel = [], mass = [];
  for (const { p, v, m } of b) {
    pos.push(...add(g.center, tilted(p, deg)));
    vel.push(...tilted(v, deg));
    mass.push(Math.round(m * 1e8) / 1e8);
  }
  return { step: 0, t: 0, pos: pos.map(r5), vel: vel.map(r5), mass, worker: "", lang: "", ms: 0, at: Date.now() };
}

// Centre de masse et masse totale : ce que les autres galaxies « voient » de celle-ci.
function summary(state) {
  let m = 0, x = 0, y = 0, z = 0;
  state.mass.forEach((mi, i) => {
    m += mi; x += mi * state.pos[3 * i]; y += mi * state.pos[3 * i + 1]; z += mi * state.pos[3 * i + 2];
  });
  return {
    step: state.step, t: state.t, com: [r5(x / m), r5(y / m), r5(z / m)], mass: r5(m),
    worker: state.worker, lang: state.lang, ms: state.ms ?? 0, at: state.at,
  };
}

// --- l'univers ----------------------------------------------------------------------------------

async function allGalaxies() {
  const ids = (await listIds("galaxies")).sort(); // ids triables par date : les plus anciennes d'abord
  const [docs, sums, held] = await Promise.all([
    Promise.all(ids.map((id) => getDoc("galaxies", id))),
    Promise.all(ids.map((id) => getDoc("summaries", id))),
    leases(),
  ]);
  const now = Date.now();
  return docs.map((g, k) => {
    if (!g) return null;
    const s = sums[k];
    const step = s?.step ?? 0;
    const lease = held[g.id];
    const status = g.error ? "error"
      : step >= g.steps ? "finished" : g.paused ? "paused" : lease && lease.until > now ? "running" : "waiting";
    return {
      id: g.id, slot: g.slot, center: g.center, n: g.n, steps: g.steps, model: g.model, seed: g.seed, name: g.name ?? "",
      step, t: s?.t ?? 0, worker: status === "running" ? lease.holder : s?.worker ?? g.errorBy ?? "",
      lang: s?.lang ?? "", ms: s?.ms ?? 0, status, com: s?.com ?? g.center,
      ...(g.error ? { error: g.error } : {}),
    };
  }).filter(Boolean);
}

// Performances par langage, sur les galaxies en cours : combien, par combien de workers, et le
// temps de calcul moyen d'un pas (ms, mesuré par le worker lui-même).
function byLang(gs) {
  const out = {};
  for (const g of gs.filter((x) => x.status === "running" && x.lang)) {
    const o = (out[g.lang] ??= { running: 0, workers: new Set(), ms: 0 });
    o.running++; o.workers.add(g.worker); o.ms += g.ms;
  }
  return Object.fromEntries(Object.entries(out).map(([l, o]) =>
    [l, { running: o.running, workers: o.workers.size, msPerStep: Math.round((o.ms / o.running) * 10) / 10 }]));
}

async function stats() {
  const gs = await allGalaxies();
  const count = (st) => gs.filter((g) => g.status === st).length;
  return {
    galaxies: gs.length, running: count("running"), waiting: count("waiting"), finished: count("finished"),
    error: count("error"), paused: count("paused"),
    workers: [...new Set(gs.filter((g) => g.status === "running").map((g) => g.worker))].length,
    langs: byLang(gs), pod: POD,
  };
}

async function universe() {
  const gs = await allGalaxies();
  const states = await Promise.all(gs.map((g) => getDoc("states", g.id)));
  return { galaxies: gs.map((g, k) => ({ ...g, pos: states[k]?.pos.map(r2) ?? [] })), pod: POD };
}

app.get("/metrics", wrap(async (_req, res) => {
  res.set("content-type", client.register.contentType);
  res.send(await client.register.metrics());
}));

app.get("/api/health", wrap(async (_req, res) => {
  let storeOk = false;
  try {
    storeOk = (await fetch(`${STORE_URL}/health`)).ok;
  } catch { /* store injoignable */ }
  res.status(storeOk ? 200 : 503).json({ status: storeOk ? "ok" : "degraded", store: storeOk, pod: POD });
}));

app.get("/api/stats", wrap(async (_req, res) => res.json(await stats())));

app.get("/api/galaxies", wrap(async (_req, res) => res.json(await allGalaxies())));

app.post("/api/galaxies", wrap(async (req, res) => {
  const b = req.body ?? {};
  const g = {
    n: Number(b.n ?? 1000),
    steps: Number(b.steps ?? 2000),
    dt: Number(b.dt ?? 0.03),
    eps: Number(b.eps ?? 0.2),
    model: String(b.model ?? "disque"),
    seed: Number(b.seed ?? Math.floor(Math.random() * 1e9)),
    radius: Number(b.radius ?? 3),
    tilt: Number(b.tilt ?? 0),
    spin: Number(b.spin ?? 1),
    name: String(b.name ?? "").slice(0, 40),
  };
  const bad = Object.entries(g).find(([k, v]) => k !== "model" && k !== "name" && !Number.isFinite(v));
  if (bad) return res.status(400).json({ error: `${bad[0]} doit être un nombre` });
  if (!MODELS.includes(g.model)) return res.status(400).json({ error: `model : ${MODELS.join(", ")}` });
  if (!Number.isInteger(g.n) || g.n < 50 || g.n > MAX_N) return res.status(400).json({ error: `n entier entre 50 et ${MAX_N}` });
  if (!Number.isInteger(g.steps) || g.steps < 1 || g.steps > 100000) return res.status(400).json({ error: "steps entier entre 1 et 100000" });
  if (!(g.dt > 0 && g.dt <= 0.2)) return res.status(400).json({ error: "dt entre 0 (exclu) et 0,2" });
  if (!(g.eps > 0 && g.eps <= 1)) return res.status(400).json({ error: "eps entre 0 (exclu) et 1" });
  if (!Number.isInteger(g.seed)) return res.status(400).json({ error: "seed entier" });
  if (!(g.radius >= 1 && g.radius <= 5)) return res.status(400).json({ error: "radius entre 1 et 5" });
  if (!(g.tilt >= 0 && g.tilt <= 180)) return res.status(400).json({ error: "tilt entre 0 et 180 (degrés)" });
  if (g.spin !== 1 && g.spin !== -1) return res.status(400).json({ error: "spin : 1 ou -1" });

  // Une case par galaxie, 4 par ligne : la première case libre.
  const used = new Set((await allGalaxies()).map((x) => x.slot));
  let slot = 0;
  while (used.has(slot)) slot++;
  g.slot = slot;
  g.center = [(slot % 4) * SPACING, -Math.floor(slot / 4) * SPACING, 0];
  // id triable par date : les plus anciennes galaxies sont adoptées d'abord
  g.id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  g.createdAt = new Date().toISOString();
  g.createdBy = POD;
  // l'état initial (pas 0), pour tous les modèles : les workers n'ont plus qu'à simuler
  const state = initial(g);
  await store("PUT", `/docs/states/${g.id}`, state);
  await store("PUT", `/docs/summaries/${g.id}`, summary(state));
  await store("PUT", `/docs/galaxies/${g.id}`, g);
  galaxiesCreated.inc();
  res.status(201).json({ id: g.id, slot: g.slot, center: g.center });
}));

// --- interactions de l'utilisateur -------------------------------------------------------------
// Une file par galaxie, dans le store. La gateway y DÉPOSE l'interaction (les corps à ajouter) ;
// seul le worker qui tient le bail de la galaxie la RÉCUPÈRE, et c'est lui qui l'applique à son
// état. La gateway ne modifie jamais l'état d'une galaxie en cours de calcul : pas de conflit avec
// le pas que le worker est en train de calculer.
const queueOf = (id) => `interactions-${id}`;
const INTERACTION_TYPES = ["particules", "tir"];

function interactionBodies(type, b, com, R, rnd) {
  const flat = (u) => normed([u[0], u[1], 0.3 * u[2]]); // plutôt dans le plan des galaxies
  const out = [];
  if (type === "particules") {
    // un nuage qui part du bord de la galaxie et tombe vers son centre
    const d = flat(unit(rnd)), start = add(com, d.map((x) => x * 1.6 * R));
    for (let i = 0; i < b.count; i++) {
      const p = start.map((x) => x + 0.25 * gauss(rnd));
      const v = d.map((x) => -0.5 * x + 0.05 * gauss(rnd));
      out.push({ p, v, m: 0.0005 });
    }
  } else {
    // un projectile lourd, lancé de loin, qui vise près du centre et traverse la galaxie
    const d = flat(unit(rnd)), start = add(com, d.map((x) => x * 4 * R));
    const aim = add(com, normed(cross(d, unit(rnd))).map((x) => x * 0.3 * R * rnd()));
    const dir = normed([aim[0] - start[0], aim[1] - start[1], aim[2] - start[2]]);
    out.push({ p: start, v: dir.map((x) => x * b.speed), m: b.mass });
  }
  return {
    pos: out.flatMap((o) => o.p).map(r5), vel: out.flatMap((o) => o.v).map(r5),
    mass: out.map((o) => Math.round(o.m * 1e8) / 1e8),
  };
}

app.post("/api/galaxies/:id/interactions", wrap(async (req, res) => {
  const id = req.params.id;
  const type = String(req.body?.type ?? "");
  if (!INTERACTION_TYPES.includes(type)) return res.status(400).json({ error: `type : ${INTERACTION_TYPES.join(", ")}` });
  const b = { count: Number(req.body?.count ?? 50), speed: Number(req.body?.speed ?? 2), mass: Number(req.body?.mass ?? 0.3) };
  if (type === "particules" && !(Number.isInteger(b.count) && b.count >= 1 && b.count <= 500)) return res.status(400).json({ error: "count entier entre 1 et 500" });
  if (type === "tir" && !(b.speed >= 0.1 && b.speed <= 10)) return res.status(400).json({ error: "speed entre 0,1 et 10" });
  if (type === "tir" && !(b.mass >= 0.001 && b.mass <= 5)) return res.status(400).json({ error: "mass entre 0,001 et 5" });
  const galaxy = await getDoc("galaxies", id);
  if (!galaxy) return res.status(404).json({ error: "galaxie inconnue (supprimée ?)" });
  const sum = await getDoc("summaries", id);
  if (galaxy.error || (sum?.step ?? 0) >= galaxy.steps) return res.status(409).json({ error: "galaxie terminée ou en erreur : plus personne ne la calcule" });
  const seed = crypto.randomBytes(4).readUInt32LE(0);
  const bodies = interactionBodies(type, b, sum?.com ?? galaxy.center, galaxy.radius ?? 3, mulberry32(seed));
  const item = { id: `${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`, type, seed, at: Date.now(), ...bodies };
  await store("POST", `/queues/${queueOf(id)}`, item);
  interactionsDone.inc({ type });
  console.log(`interaction ${item.id} (${type}, ${bodies.mass.length} corps) déposée pour la galaxie ${id}`);
  res.status(202).json({ id: item.id, type, bodies: bodies.mass.length });
}));

// Seul le worker qui tient le bail récupère les interactions (et la file est vidée d'un coup).
app.get("/api/galaxies/:id/interactions", wrap(async (req, res) => {
  const id = req.params.id;
  const worker = String(req.query.worker ?? "");
  const lease = (await leases())[id];
  if (!worker || !lease || lease.holder !== worker || lease.until <= Date.now()) {
    return res.status(409).json({ error: "seul le worker qui calcule la galaxie récupère ses interactions", holder: lease?.holder ?? null });
  }
  const { body } = await store("POST", `/queues/${queueOf(id)}/drain`);
  res.json((body ?? []).map(({ id: iid, type, pos, vel, mass }) => ({ id: iid, type, pos, vel, mass })));
}));

async function removeGalaxy(id) {
  await store("DELETE", `/docs/galaxies/${encodeURIComponent(id)}`);
  await Promise.all(["states", "summaries"].map((col) => store("DELETE", `/docs/${col}/${encodeURIComponent(id)}`)));
  await store("DELETE", `/leases/${encodeURIComponent(id)}`);
  await store("DELETE", `/queues/${queueOf(id)}`);
}

app.delete("/api/galaxies", wrap(async (_req, res) => {
  await Promise.all((await listIds("galaxies")).map(removeGalaxy));
  res.status(204).end();
}));

app.get("/api/universe", wrap(async (_req, res) => res.json(await universe())));

// Le « champ » : pour chaque galaxie, sa masse et son centre de masse (INTERACTIONS=1).
app.get("/api/galaxies/field", wrap(async (_req, res) => {
  const ids = await listIds("summaries");
  const sums = await Promise.all(ids.map((id) => getDoc("summaries", id)));
  res.json(ids.map((id, k) => sums[k] && { id, com: sums[k].com, mass: sums[k].mass }).filter(Boolean));
}));

// Les workers vivants : ceux qui tiennent une galaxie (bail valide) et ceux qui ont demandé du
// travail il y a moins de WORKER_TTL_MS (libres). Rangés dans le store : toutes les gateways les voient.
async function allWorkers() {
  const ids = await listIds("workers");
  const [docs, gs] = await Promise.all([Promise.all(ids.map((id) => getDoc("workers", id))), allGalaxies()]);
  const now = Date.now();
  const busy = new Map(); // worker → galaxie qu'il calcule
  for (const g of gs) if (g.status === "running") busy.set(g.worker, g);
  const out = new Map();
  docs.forEach((w, k) => {
    if (!w) return;
    if (now - w.at > 3600000 && !busy.has(w.name)) { store("DELETE", `/docs/workers/${ids[k]}`).catch(() => {}); return; }
    if (busy.has(w.name) || now - w.at < WORKER_TTL_MS) out.set(w.name, { name: w.name, lang: w.lang });
  });
  for (const [name, g] of busy) if (!out.has(name)) out.set(name, { name, lang: g.lang });
  return [...out.values()]
    .map((w) => ({ ...w, status: busy.has(w.name) ? "busy" : "idle", galaxy: busy.get(w.name)?.id ?? null, slot: busy.get(w.name)?.slot ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

app.get("/api/workers", wrap(async (_req, res) => res.json(await allWorkers())));

// Un worker cherche du travail : la plus ancienne galaxie sans worker dont il obtient le bail.
app.post("/api/galaxies/claim", wrap(async (req, res) => {
  const worker = String(req.body?.worker ?? "");
  if (!worker) return res.status(400).json({ error: "worker attendu" });
  // « je suis là » : le worker apparaît dans /api/workers (libre tant qu'il n'a pas de galaxie)
  await store("PUT", `/docs/workers/${encodeURIComponent(worker)}`, { name: worker, lang: String(req.body?.lang ?? ""), at: Date.now() })
    .catch(() => {}); // nom refusé par le store (caractères spéciaux) : tant pis pour la liste
  for (const g of await allGalaxies()) {
    // libre, ou déjà à ce worker (même nom : son conteneur a redémarré) ; jamais une galaxie en erreur
    if (g.status === "finished" || g.status === "error" || g.status === "paused" || (g.status === "running" && g.worker !== worker)) continue;
    const { status } = await store("POST", `/leases/${encodeURIComponent(g.id)}`, { holder: worker, ttl: LEASE_MS });
    if (status !== 200) continue; // un autre worker vient de la prendre
    const [galaxy, state] = await Promise.all([getDoc("galaxies", g.id), getDoc("states", g.id)]);
    if (!galaxy || galaxy.error || galaxy.paused) continue; // supprimée, en erreur ou en pause entre-temps
    const { id, n, steps, dt, eps, model, seed, center } = galaxy;
    console.log(`galaxie ${id} adoptée par ${worker} au pas ${state?.step ?? 0}`);
    return res.json({
      galaxy: { id, n, steps, dt, eps, model, seed, center },
      state: state && { step: state.step, t: state.t, pos: state.pos, vel: state.vel, mass: state.mass },
    });
  }
  res.status(204).end();
}));

app.put("/api/galaxies/:id/state", wrap(async (req, res) => {
  const id = req.params.id;
  const { worker, lang, ms, step, t, pos, vel } = req.body ?? {};
  const galaxy = await getDoc("galaxies", id);
  if (!galaxy) return res.status(404).json({ error: "galaxie inconnue (supprimée ?)" });
  if (galaxy.error) return res.status(409).json({ error: `galaxie en erreur : ${galaxy.error}` });
  if (galaxy.paused) return res.status(409).json({ error: "galaxie en pause" });
  // mass : envoyée par le worker quand des corps ont été ajoutés (interactions) ; sinon, on garde l'ancienne
  const newMass = req.body?.mass;
  if (newMass !== undefined && (!Array.isArray(newMass) || newMass.length < 1 || newMass.length > MAX_N + 50000 || !newMass.every(Number.isFinite))) {
    return res.status(400).json({ error: "mass : liste de nombres attendue" });
  }
  const n = Array.isArray(newMass) ? newMass.length : galaxy.n;
  if (!Array.isArray(pos) || !Array.isArray(vel) || pos.length !== n * 3 || vel.length !== n * 3) {
    return res.status(400).json({ error: `pos et vel : ${n * 3} nombres attendus (${n} corps${Array.isArray(newMass) ? "" : " ; joignez mass si le nombre de corps a changé"})` });
  }
  // Le bail se renouvelle à chaque pas : c'est le « je suis toujours là » du worker.
  const lease = await store("POST", `/leases/${encodeURIComponent(id)}`, { holder: String(worker ?? ""), ttl: LEASE_MS });
  if (lease.status !== 200) return res.status(409).json({ error: "galaxie reprise par un autre worker", holder: lease.body?.holder });
  const prev = await getDoc("states", id);
  if (!prev) return res.status(409).json({ error: "galaxie sans état initial" });
  if (step !== prev.step + 1) return res.status(400).json({ error: `pas ${prev.step + 1} attendu` });
  const mass = Array.isArray(newMass) ? newMass : prev.mass;
  if (mass.length * 3 !== pos.length) return res.status(400).json({ error: `mass : ${pos.length / 3} masses attendues` });
  if (n !== galaxy.n) { // des corps ont été ajoutés : la galaxie change de taille
    const fresh = await getDoc("galaxies", id); // relue : ne pas écraser une pause, ne pas ressusciter une galaxie supprimée
    if (fresh) await store("PUT", `/docs/galaxies/${id}`, { ...fresh, n });
  }
  const state = { step, t: Number(t), pos, vel, mass, worker, lang, ms, at: Date.now() };
  await store("PUT", `/docs/states/${id}`, state);
  await store("PUT", `/docs/summaries/${id}`, summary(state));
  // supprimée pendant ce pas : on ne laisse pas son état derrière elle
  if (!(await getDoc("galaxies", id))) {
    await Promise.all(["states", "summaries"].map((col) => store("DELETE", `/docs/${col}/${encodeURIComponent(id)}`)));
    return res.status(404).json({ error: "galaxie supprimée" });
  }
  if (step >= 1) stepsDone.inc({ lang: String(lang ?? "inconnu") });
  if (step >= galaxy.steps) {
    await store("DELETE", `/leases/${encodeURIComponent(id)}?holder=${encodeURIComponent(worker)}`);
    console.log(`galaxie ${id} terminée (${step} pas)`);
  }
  res.status(204).end();
}));

app.post("/api/galaxies/:id/release", wrap(async (req, res) => {
  const worker = String(req.body?.worker ?? "");
  await store("DELETE", `/leases/${encodeURIComponent(req.params.id)}?holder=${encodeURIComponent(worker)}`);
  if (worker) await store("DELETE", `/docs/workers/${encodeURIComponent(worker)}`).catch(() => {});
  console.log(`galaxie ${req.params.id} rendue par ${worker}`);
  res.status(204).end();
}));

// Cas anormal : un worker qui ne sait pas simuler une galaxie (modèle inconnu…) le dit :
// la galaxie passe en `error` (visible dans le front), plus personne ne l'adopte, le bail est rendu.
app.post("/api/galaxies/:id/error", wrap(async (req, res) => {
  const id = req.params.id;
  const worker = String(req.body?.worker ?? "");
  const lang = String(req.body?.lang ?? "");
  const error = String(req.body?.error ?? "").slice(0, 500);
  if (!worker || !error) return res.status(400).json({ error: "worker et error attendus" });
  const galaxy = await getDoc("galaxies", id);
  if (!galaxy) return res.status(404).json({ error: "galaxie inconnue (supprimée ?)" });
  const lease = (await leases())[id];
  if (lease && lease.holder !== worker && lease.until > Date.now()) {
    return res.status(409).json({ error: "galaxie tenue par un autre worker", holder: lease.holder });
  }
  galaxy.error = `${error} (worker ${worker}${lang ? `, ${lang}` : ""})`;
  galaxy.errorBy = worker;
  galaxy.errorAt = new Date().toISOString();
  await store("PUT", `/docs/galaxies/${id}`, galaxy);
  await store("DELETE", `/leases/${encodeURIComponent(id)}`);
  console.log(`galaxie ${id} en erreur : ${galaxy.error}`);
  res.status(204).end();
}));

// Arrêter une simulation : la galaxie est marquée en pause et son bail est retiré. Son worker
// reçoit 409 au pas suivant, la lâche et cherche une autre galaxie. L'état reste dans le store.
async function setPaused(id, paused) {
  const galaxy = await getDoc("galaxies", id);
  if (!galaxy) return false;
  if (paused) galaxy.paused = true; else delete galaxy.paused;
  await store("PUT", `/docs/galaxies/${encodeURIComponent(id)}`, galaxy);
  await store("DELETE", `/leases/${encodeURIComponent(id)}`);
  console.log(`galaxie ${id} ${paused ? "mise en pause" : "reprise"}`);
  return true;
}

app.post("/api/galaxies/:id/pause", wrap(async (req, res) => {
  if (!(await setPaused(req.params.id, true))) return res.status(404).json({ error: "galaxie inconnue" });
  res.status(204).end();
}));

app.post("/api/galaxies/:id/resume", wrap(async (req, res) => {
  if (!(await setPaused(req.params.id, false))) return res.status(404).json({ error: "galaxie inconnue" });
  res.status(204).end();
}));

app.delete("/api/galaxies/:id", wrap(async (req, res) => {
  await removeGalaxy(req.params.id);
  res.status(204).end();
}));

app.use((err, _req, res, _next) => {
  console.error(err.message ?? err);
  res.status(502).json({ error: "le store ne répond pas", detail: String(err.message ?? err) });
});

const server = app.listen(PORT, () => console.log(`gateway prête sur :${PORT}, store = ${STORE_URL}`));

// Arrêt propre : Kubernetes envoie SIGTERM avant de tuer le pod.
process.on("SIGTERM", () => {
  console.log("arrêt demandé : fin des requêtes en cours");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
