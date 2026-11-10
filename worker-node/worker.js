// worker (Node, FOURNI) — la référence des autres workers : votre worker, dans le langage de votre choix,
// respecte le même contrat (routes, variables, physique, arrondis, métriques, arrêt propre).
// Il simule UNE galaxie, pas après pas : il demande une galaxie à la gateway, la fait avancer, rend
// chaque nouvel état. Il ne garde rien d'important : l'état de sa galaxie est dans le store.
// Seul port ouvert : METRICS_PORT (9100), pour Prometheus et les sondes (GET /metrics).
//
//   POST {GATEWAY_URL}/api/galaxies/claim          → {galaxy, state} une galaxie libre, ou 204
//                                                    (l'état initial est toujours créé par la gateway)
//   PUT  {GATEWAY_URL}/api/galaxies/:id/state      → rend un pas (204 ; 409/404 = galaxie perdue)
//   POST {GATEWAY_URL}/api/galaxies/:id/release    → rend la galaxie (à l'arrêt)
//   GET  {GATEWAY_URL}/api/galaxies/field          → les autres galaxies (si INTERACTIONS=1)
//   GET  {GATEWAY_URL}/api/galaxies/:id/interactions?worker=<nom>
//                                                  → [{id, type, pos, vel, mass}] les interactions de
//                                                    l'utilisateur en attente (particules envoyées, tir),
//                                                    à ajouter à la galaxie AVANT le pas ; 409 = galaxie perdue.
//                                                    Quand des corps sont ajoutés, le PUT suivant joint `mass`.
import http from "node:http";
import os from "node:os";

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:3000";
const POLL_MS = Number(process.env.POLL_MS ?? 1000);
const NAME = process.env.WORKER_NAME ?? os.hostname();
const METRICS_PORT = Number(process.env.METRICS_PORT ?? 9100);
// Délai ajouté à chaque pas, pour que la galaxie tourne à une vitesse lisible à l'œil (40 ms par
// défaut). STEP_DELAY_MS=0 : le worker calcule sans pause, une vraie charge CPU.
const STEP_DELAY_MS = Number(process.env.STEP_DELAY_MS ?? 40);
// Mode avancé : les galaxies s'attirent entre elles (chacune vue comme une masse en son centre).
const INTERACTIONS = ["1", "true", "oui"].includes(String(process.env.INTERACTIONS ?? "0").toLowerCase());
const LANG = "node";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r5 = (x) => Math.round(x * 1e5) / 1e5;

// --- métriques (format texte Prometheus, écrit à la main : aucune dépendance) ---
const BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30];
const m = { steps: 0, busy: 0, sum: 0, count: 0, buckets: BUCKETS.map(() => 0) };
function observe(seconds) {
  m.sum += seconds;
  m.count++;
  BUCKETS.forEach((b, i) => { if (seconds <= b) m.buckets[i]++; });
}
function metrics() {
  const l = `lang="${LANG}"`;
  const lines = [
    "# HELP nbody_worker_steps_total Pas calculés", "# TYPE nbody_worker_steps_total counter",
    `nbody_worker_steps_total{${l}} ${m.steps}`,
    "# HELP nbody_worker_busy 1 si le worker simule une galaxie, 0 s'il attend", "# TYPE nbody_worker_busy gauge",
    `nbody_worker_busy{${l}} ${m.busy}`,
    "# HELP nbody_worker_step_seconds Durée de calcul d'un pas", "# TYPE nbody_worker_step_seconds histogram",
    ...BUCKETS.map((b, i) => `nbody_worker_step_seconds_bucket{${l},le="${b}"} ${m.buckets[i]}`),
    `nbody_worker_step_seconds_bucket{${l},le="+Inf"} ${m.count}`,
    `nbody_worker_step_seconds_sum{${l}} ${m.sum}`,
    `nbody_worker_step_seconds_count{${l}} ${m.count}`,
  ];
  return lines.join("\n") + "\n";
}
http.createServer((req, res) => {
  if (req.url === "/metrics") {
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    return res.end(metrics());
  }
  res.writeHead(404).end();
}).on("error", (e) => {
  // port déjà pris (deux workers sur la même machine, sans METRICS_PORT) : on continue sans métriques
  console.error(`métriques : port ${METRICS_PORT} indisponible (${e.code}) ; lancez ce worker avec METRICS_PORT=<autre port>`);
}).listen(METRICS_PORT);

// --- la physique (G = 1) : la même dans tous les workers ---
//   a_i = Σ_j≠i m_j (r_j − r_i) / (|r_j − r_i|² + eps²)^(3/2)
// plus, si INTERACTIONS, l'attraction de chaque autre galaxie g (masse M_g, centre c_g) :
//   a_i += M_g (c_g − r_i) / (|c_g − r_i|² + 1)^(3/2)
// puis v += a·dt, puis r += v·dt (avec le nouveau v : Euler symplectique). Arrondi à 5 décimales.
function step(galaxy, state, others) {
  const { dt, eps } = galaxy;
  const { pos, vel, mass } = state;
  const n = mass.length; // le nombre de corps peut grandir (interactions de l'utilisateur)
  const e2 = eps * eps;
  const newPos = new Array(n * 3);
  const newVel = new Array(n * 3);
  for (let i = 0; i < n; i++) {
    const xi = pos[3 * i], yi = pos[3 * i + 1], zi = pos[3 * i + 2];
    let ax = 0, ay = 0, az = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const dx = pos[3 * j] - xi, dy = pos[3 * j + 1] - yi, dz = pos[3 * j + 2] - zi;
      const d2 = dx * dx + dy * dy + dz * dz + e2;
      const f = mass[j] / (d2 * Math.sqrt(d2));
      ax += f * dx; ay += f * dy; az += f * dz;
    }
    for (const g of others) {
      const dx = g.com[0] - xi, dy = g.com[1] - yi, dz = g.com[2] - zi;
      const d2 = dx * dx + dy * dy + dz * dz + 1;
      const f = g.mass / (d2 * Math.sqrt(d2));
      ax += f * dx; ay += f * dy; az += f * dz;
    }
    const vx = vel[3 * i] + ax * dt, vy = vel[3 * i + 1] + ay * dt, vz = vel[3 * i + 2] + az * dt;
    newVel[3 * i] = r5(vx); newVel[3 * i + 1] = r5(vy); newVel[3 * i + 2] = r5(vz);
    newPos[3 * i] = r5(xi + vx * dt); newPos[3 * i + 1] = r5(yi + vy * dt); newPos[3 * i + 2] = r5(zi + vz * dt);
  }
  return { step: state.step + 1, t: r5(state.t + dt), pos: newPos, vel: newVel, mass };
}

async function call(method, path, body) {
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
}

// withMass : le nombre de corps a changé depuis le dernier PUT, on envoie les masses
const putState = (id, state, ms, withMass) => call("PUT", `/api/galaxies/${id}/state`, {
  worker: NAME, lang: LANG, ms, step: state.step, t: state.t, pos: state.pos, vel: state.vel,
  ...(withMass ? { mass: state.mass } : {}),
});

// Les interactions de l'utilisateur, déposées sur la gateway : on ajoute leurs corps à la galaxie.
// Rend null si la galaxie n'est plus à nous (409/404), sinon le nombre de corps ajoutés.
async function applyInteractions(galaxy, state) {
  const r = await call("GET", `/api/galaxies/${galaxy.id}/interactions?worker=${encodeURIComponent(NAME)}`);
  if (r.status === 409 || r.status === 404) return null;
  if (r.status !== 200) throw new Error(`interactions → ${r.status}`);
  let added = 0;
  for (const it of r.body) {
    state.pos = state.pos.concat(it.pos);
    state.vel = state.vel.concat(it.vel);
    state.mass = state.mass.concat(it.mass);
    added += it.mass.length;
    console.log(`galaxie ${galaxy.id} : interaction ${it.type} (+${it.mass.length} corps, ${state.mass.length} en tout)`);
  }
  return added;
}

// SIGTERM (arrêt du pod, réduction de l'autoscaler) : on finit le pas en cours, on rend la galaxie, on s'arrête.
let stopping = false;
process.on("SIGTERM", () => { console.log("arrêt demandé : fin du pas en cours"); stopping = true; });

// Simule la galaxie jusqu'au bout, ou jusqu'à la perdre (supprimée, reprise par un autre worker).
async function simulate(galaxy, state) {
  console.log(`galaxie ${galaxy.id} adoptée au pas ${state.step} / ${galaxy.steps} (${state.mass.length} corps)`);
  let massChanged = false;
  while (!stopping && state.step < galaxy.steps) {
    const added = await applyInteractions(galaxy, state);
    if (added === null) {
      console.log(`galaxie ${galaxy.id} perdue (en pause, supprimée ou reprise par un autre worker)`);
      return;
    }
    if (added > 0) massChanged = true;
    let others = [];
    if (INTERACTIONS) {
      const field = await call("GET", "/api/galaxies/field");
      others = (field.body ?? []).filter((g) => g.id !== galaxy.id);
    }
    const t1 = performance.now();
    state = step(galaxy, state, others);
    // ms : temps de CALCUL du pas (sans le champ ni STEP_DELAY_MS) — sert à comparer les langages
    const ms = Math.round((performance.now() - t1) * 10) / 10;
    m.steps++;
    observe(ms / 1000);
    await sleep(STEP_DELAY_MS);
    const put = await putState(galaxy.id, state, ms, massChanged);
    if (put.status === 409 || put.status === 404) {
      console.log(`galaxie ${galaxy.id} perdue (${put.status === 404 ? "supprimée" : "en pause, ou reprise par un autre worker"})`);
      return;
    }
    if (put.status !== 204) throw new Error(`state → ${put.status}`);
    massChanged = false;
    if (state.step % 100 === 0) console.log(`galaxie ${galaxy.id} : pas ${state.step} (${ms} ms)`);
  }
  if (stopping) {
    await call("POST", `/api/galaxies/${galaxy.id}/release`, { worker: NAME });
    console.log(`galaxie ${galaxy.id} rendue au pas ${state.step}`);
  } else {
    console.log(`galaxie ${galaxy.id} terminée`);
  }
}

async function loop() {
  console.log(`worker ${NAME} (node) prêt, gateway = ${GATEWAY_URL}, métriques sur :${METRICS_PORT}${INTERACTIONS ? ", interactions entre galaxies" : ""}`);
  while (!stopping) {
    try {
      const claim = await call("POST", "/api/galaxies/claim", { worker: NAME, lang: LANG });
      if (claim.status === 204) { await sleep(POLL_MS); continue; }
      if (claim.status !== 200) throw new Error(`claim → ${claim.status}`);
      m.busy = 1;
      await simulate(claim.body.galaxy, claim.body.state);
    } catch (e) {
      console.error(`gateway injoignable (${e.message}), nouvel essai dans ${POLL_MS} ms`);
      await sleep(POLL_MS);
    } finally {
      m.busy = 0;
    }
  }
  process.exit(0);
}

loop();
