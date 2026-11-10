import { useEffect, useRef, useState } from "react";
import View3D from "./View3D.jsx";

// Tout passe par la gateway, en REST (fetch /api/…) : créer, arrêter ou effacer des galaxies, lister
// les workers, et relire l'univers en boucle (GET /api/universe) pour le dessiner.
// En dev, Vite relaie /api à la gateway ; en prod, c'est nginx ou l'Ingress.
const api = (path, opts) => fetch(`/api${path}`, opts).then(async (r) => {
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
  return r.status === 204 ? null : r.json();
});
const post = (path, body) => api(path, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}),
});

const PALETTE = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#46f0f0", "#f032e6", "#bcf60c", "#fabebe", "#008080"];
const WAITING = "#666";
const ERROR = "#ff5252";
const STATUS = { running: "en cours", waiting: "attend un worker", paused: "en pause", finished: "terminée", error: "en erreur" };

// Le catalogue : des modèles de galaxie, tous en 3D, tous fabriqués par la gateway.
// (radius : rayon ; tilt : inclinaison en degrés ; spin : -1 = tourne à l'envers ; n : corps par défaut)
const CATALOGUE = [
  { id: "spirale", name: "Spirale", desc: "disque épais, vue de face", n: 1000 },
  { id: "inclinee", name: "Inclinée", desc: "disque penché de 60°", n: 1000, tilt: 60 },
  { id: "tranche", name: "Par la tranche", desc: "disque vu de profil", n: 600, tilt: 90 },
  { id: "naine", name: "Naine", desc: "petit disque rapide", n: 300, radius: 1.5 },
  { id: "geante", name: "Géante", desc: "grand disque", n: 2000, radius: 4.5 },
  { id: "retro", name: "Rétrograde", desc: "tourne à l'envers", n: 1000, tilt: 30, spin: -1 },
  { id: "elliptique", name: "Elliptique", desc: "nuage aplati, orbites en tous sens", n: 1000, model: "elliptique", tilt: 30 },
  { id: "anneau", name: "Anneau", desc: "tore en rotation", n: 1000, model: "anneau", tilt: 40 },
  { id: "collision", name: "Collision", desc: "deux disques qui se percutent", n: 1000, model: "collision", tilt: 20 },
  { id: "aleatoire", name: "Amas aléatoire", desc: "boule au repos : effondrement", n: 1000, model: "random" },
  { id: "plummer", name: "Amas de Plummer", desc: "amas sphérique à l'équilibre", n: 1000, model: "plummer" },
  { id: "double", name: "Double spirale", desc: "bulbe + deux bras spiraux", n: 1500, model: "double-spirale", tilt: 20 },
  { id: "enorme", name: "Énorme", desc: "un worker peine", n: 5000, radius: 4.5 },
];
const SIZES = [100, 300, 600, 1000, 2000, 3000, 5000, 10000, 20000];
const params = (c, n) => ({ name: c.name, model: c.model ?? "disque", n: n ?? c.n, radius: c.radius ?? 3, tilt: c.tilt ?? 0, spin: c.spin ?? 1 });
// Une « charge lourde » : 5 galaxies de 2000 corps. Elles attendent un worker : l'autoscaler en ajoute.
const HEAVY = { name: "Charge", model: "disque", n: 2000, radius: 4 };

export default function App() {
  const [health, setHealth] = useState(null);
  const [workers, setWorkers] = useState([]);
  const [choice, setChoice] = useState(CATALOGUE[0].id);
  const [n, setN] = useState(CATALOGUE[0].n);
  const [steps, setSteps] = useState(2000);
  // Graine : vide = tirée au hasard par la gateway ; même graine, même galaxie (Node comme Python).
  const [seed, setSeed] = useState("");
  const [universe, setUniverse] = useState(null);
  const [stats, setStats] = useState(null);
  const [rate, setRate] = useState(0);
  // Débit par langage (pas/s, lissé) : de combien de pas chaque galaxie a avancé depuis la dernière lecture.
  const [langRate, setLangRate] = useState({});
  const prevSteps = useRef(new Map());
  const [error, setError] = useState(null);
  // Interagir avec une galaxie : l'interaction est déposée sur la gateway, puis appliquée par le
  // worker qui calcule la galaxie, au pas suivant (ou quand un worker l'adopte, si elle attend).
  const burst = 50; // particules envoyées par Alt + clic
  const [info, setInfo] = useState(null);
  const last = useRef({ total: -1, at: 0 });

  // La santé de la gateway et les workers vivants (au travail ou libres).
  useEffect(() => {
    const tick = () => {
      api("/health").then(setHealth).catch(() => setHealth(null));
      api("/workers").then(setWorkers).catch(() => setWorkers([]));
      api("/stats").then(setStats).catch(() => setStats(null));
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => clearInterval(t);
  }, []);

  // On demande l'univers à la gateway en boucle : débit total et par langage, puis la vue 3D le redessine.
  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const u = await api("/universe");
        if (stop) return;
        const total = u.galaxies.reduce((s, g) => s + g.step, 0);
        const now = performance.now();
        const dt = now - last.current.at;
        if (last.current.total >= 0 && dt > 0) {
          if (total >= last.current.total) setRate(((total - last.current.total) * 1000) / dt);
          const inst = {};
          for (const g of u.galaxies) {
            const d = g.step - (prevSteps.current.get(g.id) ?? g.step);
            if (g.lang && d > 0) inst[g.lang] = (inst[g.lang] ?? 0) + (d * 1000) / dt;
          }
          setLangRate((old) => {
            const out = {};
            for (const l of new Set([...Object.keys(old), ...Object.keys(inst)])) out[l] = 0.85 * (old[l] ?? 0) + 0.15 * (inst[l] ?? 0);
            return out;
          });
        }
        prevSteps.current = new Map(u.galaxies.map((g) => [g.id, g.step]));
        last.current = { total, at: now };
        setUniverse(u);
        setError(null);
        setTimeout(poll, 120);
      } catch (e) {
        setError(e.message);
        if (!stop) setTimeout(poll, 2000);
      }
    };
    poll();
    return () => { stop = true; };
  }, []);

  // Une couleur par worker (la même en haut, dans la liste et dans la vue) ; gris si la galaxie
  // attend, rouge si elle est en erreur.
  const gs = universe?.galaxies ?? [];
  const names = [...new Set([...workers.map((w) => w.name), ...gs.map((g) => g.worker).filter(Boolean)])].sort();
  const workerColor = (name) => PALETTE[names.indexOf(name) % PALETTE.length];
  const colorOf = (g) => (g.status === "error" ? ERROR : g.status === "waiting" || g.status === "paused" || !g.worker ? WAITING : workerColor(g.worker));
  const label = (g) => [
    `#${g.slot}${g.name ? ` ${g.name}` : ""}`,
    g.status === "error" ? "erreur" : g.status === "waiting" ? "en attente" : g.status === "paused" ? `en pause · ${g.step}/${g.steps}` : `${g.worker} · ${g.step}/${g.steps}`,
  ];

  async function add(list) {
    setError(null);
    try {
      for (const [c, k, s] of list) await post("/galaxies", { ...params(c, k), steps, ...(s !== undefined ? { seed: s } : {}) });
    } catch (err) {
      setError(err.message);
    }
  }
  const pick = () => CATALOGUE.find((c) => c.id === choice);
  const pool = CATALOGUE;
  const random = (k) => Array.from({ length: k }, () => [pool[Math.floor(Math.random() * pool.length)]]);
  const choose = (c) => { setChoice(c.id); setN(c.n); };

  // Arrêter / reprendre / supprimer une simulation. En pause, la galaxie garde son état dans
  // le store ; son worker la lâche et passe à une autre.
  async function act(g, what) {
    setError(null);
    const req = what === "delete" ? api(`/galaxies/${g.id}`, { method: "DELETE" }) : post(`/galaxies/${g.id}/${what}`);
    await req.catch((err) => setError(err.message));
  }
  async function interact(g, body) {
    setError(null);
    try {
      const r = await post(`/galaxies/${g.id}/interactions`, body);
      const what = r.type === "tir" ? "un tir" : `${r.bodies} particule${r.bodies > 1 ? "s" : ""}`;
      const when = g.status === "running" ? "son worker l'applique au pas suivant" : "appliqué quand un worker la calculera";
      setInfo(`#${g.slot} : ${what} déposé${r.type === "tir" ? "" : "es"} sur la gateway — ${when}`);
      setTimeout(() => setInfo(null), 4000);
    } catch (err) {
      setError(err.message);
    }
  }
  async function all(what, from) {
    setError(null);
    await Promise.all(gs.filter((g) => from.includes(g.status)).map((g) => post(`/galaxies/${g.id}/${what}`)))
      .catch((err) => setError(err.message));
  }
  async function clear() {
    setError(null);
    await api("/galaxies", { method: "DELETE" }).catch((err) => setError(err.message));
  }

  const count = (st) => gs.filter((g) => g.status === st).length;
  const failed = gs.filter((g) => g.status === "error");
  const idle = workers.filter((w) => w.status === "idle").length;

  return (
    <main>
      <header>
        <h1>nbody</h1>
        <div className="workers" title="les workers vivants : chacun calcule une galaxie, ou attend qu'il y en ait une">
          <span className="muted">workers {workers.length} · libres {idle}</span>
          {workers.map((w) => (
            <span key={w.name} className={`chip ${w.status}`} style={{ borderColor: workerColor(w.name) }}>
              <span className="dot" style={{ background: w.status === "busy" ? workerColor(w.name) : "transparent", borderColor: workerColor(w.name) }} />
              {w.name}{w.lang ? <small> {w.lang}</small> : null}
              <small>{w.status === "busy" ? ` · #${w.slot}` : " · libre"}</small>
            </span>
          ))}
          {workers.length === 0 && <span className="chip none">aucun worker</span>}
        </div>
        <span className={`badge ${health?.store ? "ok" : "ko"}`}>
          {health ? `gateway ${health.pod} · store ${health.store ? "ok" : "injoignable"}` : "gateway injoignable"}
        </span>
      </header>

      <section className="catalogue">
        {CATALOGUE.map((c) => (
          <button key={c.id} type="button" className={`card ${choice === c.id ? "selected" : ""}`}
            onClick={() => choose(c)} onDoubleClick={() => add([[c]])} title="double-clic : l'ajouter tout de suite">
            <strong>{c.name}</strong><span>{c.desc}</span><span>{c.n.toLocaleString("fr-FR")} corps</span>
          </button>
        ))}
      </section>

      <form onSubmit={(e) => { e.preventDefault(); add([[pick(), n, seed === "" ? undefined : Number(seed)]]); }}>
        <label>Corps
          <select value={n} onChange={(e) => setN(Number(e.target.value))}>
            {[...new Set([...SIZES, n])].sort((a, b) => a - b).map((v) => <option key={v} value={v}>{v.toLocaleString("fr-FR")}</option>)}
          </select>
        </label>
        <label>Pas
          <input type="number" min="100" max="100000" step="100" value={steps} onChange={(e) => setSteps(Number(e.target.value))} />
        </label>
        <label>Graine
          <input type="number" min="0" max="999999999" step="1" placeholder="au hasard" value={seed}
            onChange={(e) => setSeed(e.target.value)} title="même graine = mêmes corps de départ ; vide = au hasard" style={{ width: "8em" }} />
        </label>
        <button type="submit">Ajouter « {pick().name} » ({n.toLocaleString("fr-FR")} corps)</button>
        <button type="button" onClick={() => add(random(4))} title="4 galaxies tirées au hasard dans le catalogue">+4 au hasard</button>
        <button type="button" className="load" onClick={() => add(Array(5).fill([HEAVY]))} title="5 galaxies de 2000 corps : elles attendent un worker, l'autoscaler en ajoute">Charge ×5</button>
        <span className="spacer" />
        <button type="button" className="secondary" onClick={() => all("pause", ["running", "waiting"])}>Tout arrêter</button>
        <button type="button" className="secondary" onClick={() => all("resume", ["paused"])}>Tout reprendre</button>
        <button type="button" className="secondary" onClick={clear}>Tout effacer</button>
      </form>

      {error && <p className="error">{error}</p>}
      {info && <p className="muted">{info}</p>}
      {failed.map((g) => <p key={g.id} className="error">galaxie #{g.slot} ({g.name || g.model}) : {g.error}</p>)}

      <section className="view">
        <View3D galaxies={gs} colorOf={colorOf} label={label}
          onPick={(g, alt) => g.status !== "finished" && g.status !== "error" && interact(g, alt ? { type: "particules", count: burst } : { type: "tir" })} />
        <aside>
          <p><strong>{gs.length} galaxie{gs.length > 1 ? "s" : ""}</strong></p>
          <p className="muted">
            {count("running")} en cours · {count("waiting")} en attente{count("paused") ? ` · ${count("paused")} en pause` : ""}{count("error") ? ` · ${count("error")} en erreur` : ""} · {rate.toFixed(1)} pas/s
          </p>
          {[...new Set(gs.filter((g) => g.status === "running" && g.lang).map((g) => g.lang))].sort().map((l) => {
            const run = gs.filter((g) => g.status === "running" && g.lang === l);
            const ms = run.reduce((a, g) => a + (g.ms ?? 0), 0) / run.length;
            return (
              <p key={l} className="muted" title="pas/s : débit total du langage ; ms/pas : temps de calcul d'un pas, sans le délai STEP_DELAY_MS">
                <strong>{l}</strong> · {run.length} galaxie{run.length > 1 ? "s" : ""} · {(langRate[l] ?? 0).toFixed(1)} pas/s · {ms.toFixed(1)} ms/pas
              </p>
            );
          })}
          <p className="muted">charge (galaxies sans worker) : <strong>{stats?.waiting ?? "?"}</strong></p>
          <h2>Galaxies</h2>
          {gs.length === 0 && <p className="muted">aucune : choisissez-en une dans le catalogue</p>}
          <ul>
            {gs.map((g) => (
              <li key={g.id} title={g.error ?? `${STATUS[g.status]} · graine ${g.seed}`}>
                <span className="dot" style={{ background: colorOf(g), opacity: g.status === "finished" || g.status === "paused" ? 0.5 : 1 }} />
                <span className="name">#{g.slot} {g.name || g.model} <small>{g.n}</small></span>
                <em>{g.status === "error" ? "erreur" : g.status === "waiting" ? "attente" : g.status === "paused" ? "pause" : `${g.step}/${g.steps}`}</em>
                <span className="actions">
                  {g.status === "paused"
                    ? <button type="button" title="reprendre la simulation" onClick={() => act(g, "resume")}>▶</button>
                    : g.status !== "finished" && g.status !== "error" &&
                      <button type="button" title="arrêter la simulation (pause)" onClick={() => act(g, "pause")}>⏸</button>}
                  <button type="button" className="secondary" title="supprimer la galaxie" onClick={() => act(g, "delete")}>✕</button>
                </span>
              </li>
            ))}
          </ul>
          <p className="muted">un worker = une galaxie à la fois ; une galaxie sans worker est grise (pâle si en pause), en erreur rouge</p>
        </aside>
      </section>
    </main>
  );
}
