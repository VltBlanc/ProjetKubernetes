// store — la « base de fichiers » de nbody.
// Un petit service REST qui range des documents JSON, des baux et une file de tâches
// dans des fichiers, sous DATA_DIR. Un seul réplica : c'est lui qui garde l'état.
//
//   GET  /health                      → 200 {status:"ok"}
//   PUT  /docs/:col/:id               → range le document (corps JSON)
//   PUT  /docs/:col/:id?create=1      → idem, mais seulement s'il n'existe pas : 201 | 409 (déjà là)
//   DELETE /docs/:col/:id             → 204 (même si le document n'existe pas)
//   GET  /docs/:col/:id               → 200 document | 404
//   GET  /docs/:col?prefix=xxx        → 200 {ids:[…]}
//   GET  /queues/:q                   → 200 {length}
//   POST /queues/:q                   → ajoute un élément en fin de file
//   POST /queues/:q/pop               → 200 premier élément | 204 file vide
//   POST /queues/:q/drain             → 200 [tous les éléments] et vide la file, en une seule opération
//   DELETE /queues/:q                 → 204 (supprime la file)
//   POST /leases/:id                  → 200 {holder, until} bail accordé ou renouvelé
//                                       | 409 {holder, until} tenu par un autre   corps : {holder, ttl}
//   DELETE /leases/:id?holder=x       → 204 (rend le bail, s'il est bien à x)
//   GET  /leases                      → 200 {leases: {id: {holder, until}}}
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";

const PORT = Number(process.env.PORT ?? 4000);
const DATA_DIR = process.env.DATA_DIR ?? "./data";

const app = express();
app.use(express.json({ limit: "20mb" }));

const safe = (s) => /^[A-Za-z0-9_.-]+$/.test(s) && !s.startsWith(".");
const docFile = (col, id) => path.join(DATA_DIR, "docs", col, `${id}.json`);
const queueFile = (q) => path.join(DATA_DIR, "queues", `${q}.json`);
const leasesFile = () => path.join(DATA_DIR, "leases.json");

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value));
  await fs.rename(tmp, file); // écriture atomique
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}

// Les files sont modifiées une opération à la fois (un seul processus) :
// deux workers ne reçoivent jamais la même tâche.
let lock = Promise.resolve();
const serial = (fn) => (lock = lock.then(fn, fn));

app.param(["col", "id", "q"], (req, res, next, value) =>
  safe(value) ? next() : res.status(400).json({ error: "nom invalide" }));

app.get("/health", async (_req, res) => {
  await fs.mkdir(DATA_DIR, { recursive: true });
  res.json({ status: "ok", dataDir: path.resolve(DATA_DIR) });
});

// Toutes les écritures passent par `serial` : « créer si absent » est donc atomique.
// Utile quand plusieurs gateways veulent créer le même document : une seule y arrive.
app.put("/docs/:col/:id", (req, res, next) =>
  serial(async () => {
    const file = docFile(req.params.col, req.params.id);
    if (req.query.create) {
      if ((await readJson(file, null)) !== null) return res.status(409).json({ error: "existe déjà" });
      await writeJson(file, req.body);
      return res.status(201).end();
    }
    await writeJson(file, req.body);
    res.status(204).end();
  }).catch(next));

app.delete("/docs/:col/:id", (req, res, next) =>
  serial(async () => {
    await fs.rm(docFile(req.params.col, req.params.id), { force: true });
    res.status(204).end();
  }).catch(next));

app.get("/docs/:col/:id", async (req, res) => {
  const doc = await readJson(docFile(req.params.col, req.params.id), null);
  doc === null ? res.status(404).json({ error: "introuvable" }) : res.json(doc);
});

app.get("/docs/:col", async (req, res) => {
  const prefix = String(req.query.prefix ?? "");
  let files = [];
  try {
    files = await fs.readdir(path.join(DATA_DIR, "docs", req.params.col));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const ids = files
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .filter((id) => id.startsWith(prefix));
  res.json({ ids });
});

app.get("/queues/:q", (req, res, next) =>
  readJson(queueFile(req.params.q), []).then((items) => res.json({ length: items.length })).catch(next));

app.post("/queues/:q", (req, res, next) =>
  serial(async () => {
    const items = await readJson(queueFile(req.params.q), []);
    items.push(...(Array.isArray(req.body) ? req.body : [req.body]));
    await writeJson(queueFile(req.params.q), items);
    res.status(201).json({ length: items.length });
  }).catch(next));

app.post("/queues/:q/pop", (req, res, next) =>
  serial(async () => {
    const items = await readJson(queueFile(req.params.q), []);
    if (items.length === 0) return res.status(204).end();
    const first = items.shift();
    await writeJson(queueFile(req.params.q), items);
    res.json(first);
  }).catch(next));

// Prendre TOUTE la file d'un coup et la vider : atomique (passe par `serial`), donc un élément
// n'est jamais livré deux fois, même si deux gateways le demandent en même temps.
app.post("/queues/:q/drain", (req, res, next) =>
  serial(async () => {
    const items = await readJson(queueFile(req.params.q), []);
    if (items.length) await fs.rm(queueFile(req.params.q), { force: true });
    res.json(items);
  }).catch(next));

app.delete("/queues/:q", (req, res, next) =>
  serial(async () => {
    await fs.rm(queueFile(req.params.q), { force: true });
    res.status(204).end();
  }).catch(next));

// Un bail = « cette galaxie est à moi jusqu'à `until` ». Accordé seulement s'il est libre, expiré,
// ou déjà au même titulaire (renouvellement). Comme toutes les écritures, il passe par `serial` :
// deux workers ne peuvent pas obtenir la même galaxie.
app.post("/leases/:id", (req, res, next) =>
  serial(async () => {
    const holder = String(req.body?.holder ?? "");
    const ttl = Number(req.body?.ttl ?? 15000);
    if (!holder || !(ttl > 0)) return res.status(400).json({ error: "holder et ttl (ms) attendus" });
    const leases = await readJson(leasesFile(), {});
    const cur = leases[req.params.id];
    const now = Date.now();
    if (cur && cur.holder !== holder && cur.until > now) return res.status(409).json(cur);
    leases[req.params.id] = { holder, until: now + ttl };
    await writeJson(leasesFile(), leases);
    res.json(leases[req.params.id]);
  }).catch(next));

app.delete("/leases/:id", (req, res, next) =>
  serial(async () => {
    const leases = await readJson(leasesFile(), {});
    const cur = leases[req.params.id];
    if (cur && (!req.query.holder || cur.holder === req.query.holder)) {
      delete leases[req.params.id];
      await writeJson(leasesFile(), leases);
    }
    res.status(204).end();
  }).catch(next));

app.get("/leases", (_req, res, next) =>
  readJson(leasesFile(), {}).then((leases) => res.json({ leases })).catch(next));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: String(err.message ?? err) });
});

app.listen(PORT, () => console.log(`store prêt sur :${PORT}, données dans ${path.resolve(DATA_DIR)}`));
