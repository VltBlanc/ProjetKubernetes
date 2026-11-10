# nbody — projet Kubernetes (DAMS4)

Une application web qui simule un **univers de galaxies** : dans chaque galaxie, des corps s'attirent
(gravitation). Le navigateur **crée les galaxies** — disque, elliptique, anneau, collision, amas aléatoire, amas
de Plummer, double spirale, toutes fabriquées en 3D par la **gateway** — chacune dans sa propre case de
l'espace. Chaque **worker adopte une galaxie** libre et la simule pas après pas ; un **store** garde
l'état de chaque galaxie dans des fichiers. **N workers = N galaxies qui avancent en même temps** ; les
autres attendent un worker (grises). Le front relit l'univers en boucle et le dessine, chaque galaxie
de la couleur du worker (le pod) qui la calcule, avec la **charge** (les galaxies sans worker) et les
**performances de chaque langage**.

Ce code de départ est **le même pour tous les niveaux** (débutant, intermédiaire, confirmé).
L'application fonctionne telle quelle : votre travail est de la **conteneuriser** et de la
**déployer** dans Kubernetes, puis, selon votre niveau, de la mettre à l'échelle, la mesurer et la
superviser.

### Ce que vous écrivez dépend de votre niveau : voir votre sujet

Votre sujet (PDF) dit lesquelles de ces pièces sont à écrire à votre niveau :

- **un ou plusieurs workers dans d'autres langages que Node** (Python, Java, Go, Rust… selon le sujet), chacun dans un
  dossier `worker-<langage>/`, en vous inspirant du worker Node fourni (`worker-node/worker.js`) :
  même contrat (interactions de l'utilisateur comprises), même physique ;
- **un simulateur de charge** (voir « Simuler une charge sur la gateway » plus bas).

```
navigateur ──► front (React, servi par nginx)
     │
     └─ REST /api/... ──► gateway ×N ──► store (fichiers JSON sur disque)
                              ▲
                              ├── worker-node   ×N  (fourni)                    ─┐ REST : adopte une galaxie,
                              └── worker-<langage> ×N (à écrire, selon le niveau) ─┘        rend chaque pas
```

Tout passe en **HTTP/REST** (JSON). La gateway est sans état : on peut en lancer **plusieurs**, chacune
lit le store. Les workers n'ouvrent aucun port de service (seulement leurs métriques) : ce sont eux
qui appellent la gateway.


## Règles du projet

- Projet **individuel**. Le niveau (débutant, intermédiaire, confirmé) est attribué par
  l'enseignant ; le code de départ est le même pour tous, seul le sujet change.
- **Dépôt sur GitLab ou GitHub** : poussez ce dépôt dès la première séance, puis **commitez et
  poussez régulièrement** (plusieurs commits par séance), avec des messages qui disent ce qui a
  changé. L'historique fait partie de l'évaluation.
- **Pas d'IA générative pour écrire** vos Dockerfiles, vos fichiers Docker Compose, vos manifestes
  Kubernetes et vos commandes Git, **ni votre rapport** : vous devez pouvoir expliquer chaque ligne
  que vous avez écrite.
- **Il faut absolument tout comprendre** : la note compte le projet, le rapport et — la plus grosse
  partie — 5 à 10 minutes de questions-réponses, courant décembre ou janvier (planning à venir).
- **Namespace** : vous déployez dans le **namespace de votre groupe**, déjà créé sur le cluster
  (ne créez pas de namespace). Votre déploiement doit s'y appliquer sans retouche.
- **Images** : le cluster ne voit pas les images de votre machine. Publiez-les dans un registre
  qu'il peut joindre, au choix : le registre GitLab de votre dépôt, Docker Hub, ou le registre de
  Polytech (adresse donnée en séance).

## Rendu (avant le 20 décembre 2026)

Déposez sur **Moodle**, dans le devoir du projet, le **lien de votre dépôt GitLab ou GitHub**
(s'il est privé, donnez-y accès à l'enseignant). C'est l'état du dépôt à cette date qui est évalué. Il contient :

1. **Le code complété**, avec un historique de commits réguliers : un `Dockerfile` par service, vos
   manifestes Kubernetes, et ce `README` complété pour expliquer comment tout lancer.
2. **Un rapport** à la racine, **écrit par vous, sans IA**, qui **justifie les valeurs et les choix
   non classiques**, ainsi que le **choix des langages** (dont celui de votre worker, si vous en écrivez un).

Pas de slides : le rapport seulement.

## Les services

| Dossier          | Techno                  | Port(s)                | Variables d'environnement                                      | Santé / métriques |
|------------------|-------------------------|------------------------|----------------------------------------------------------------|-------------------|
| `gateway/`       | Node 22, Express        | 3000 (REST + métriques) | `PORT`, `STORE_URL` (ex. `http://store:4000`), `LEASE_MS`     | `GET /api/health`, `GET /metrics` |
| `store/`         | Node 22, Express        | 4000                   | `PORT`, `DATA_DIR` (ex. `/data`)                               | `GET /health`     |
| `worker-node/`   | Node 22, sans dépendance (**fourni**) | 9100 (métriques seulement) | `GATEWAY_URL` (ex. `http://gateway:3000`), `POLL_MS`, `STEP_DELAY_MS`, `INTERACTIONS`, `WORKER_NAME`, `METRICS_PORT` | `GET /metrics` |
| `worker-<langage>/` | un autre langage (**à écrire, selon le niveau**) | 9100 (métriques, si le sujet les demande) | les mêmes              | `GET /metrics`    |
| `front/`         | React 19 + Vite, puis nginx | 80                 | `GATEWAY_URL` (ex. `http://gateway:3000`)                      | `GET /healthz`    |

Ce qu'il faut savoir pour chacun :

- **gateway** : la seule API publique ; toutes ses routes commencent par `/api`, sauf `/metrics`.
  Sans état. `/api/health` répond **503** tant que le store est injoignable ; `/metrics` répond
  toujours. Un worker qui ne donne plus de nouvelles depuis `LEASE_MS` (15 000 ms) perd sa galaxie :
  un autre worker la reprend **là où elle en était** (son état est dans le store). Elle fabrique
  l'état initial de toutes les galaxies. Démarrage : `npm ci --omit=dev` puis `node server.js`.
- **store** : range tout sous `DATA_DIR` (une galaxie, son dernier état, son résumé, et les
  **baux** : « cette galaxie est à tel worker jusqu'à telle heure »). **C'est le seul service qui a
  des données** : sans volume, elles disparaissent avec le conteneur. **Un seul réplica** : c'est
  lui qui garantit qu'une galaxie n'est adoptée que par un seul worker.
  Démarrage : `npm ci --omit=dev` puis `node server.js`.
- **worker-node** (fourni) : demande une galaxie à la gateway toutes les `POLL_MS` ms (1000 par
  défaut) tant qu'il n'en a pas ; dès qu'il en a une, il la simule sans s'arrêter (du pur CPU : c'est
  ce qui fait monter la charge) et rend chaque pas. `STEP_DELAY_MS` ajoute un délai par pas (40 ms
  par défaut, pour que la galaxie tourne à une vitesse lisible ; 0 = calcul sans pause, une vraie
  charge CPU). `INTERACTIONS=1` : **mode avancé**, déjà écrit, les galaxies s'attirent entre elles (0 par
  défaut). `WORKER_NAME` vaut par défaut le nom de la machine — dans Kubernetes, **le nom du pod**.
  À l'arrêt (SIGTERM), il finit le pas en cours, **rend sa galaxie** (un autre worker la reprend
  tout de suite) et quitte. Il expose ses métriques sur `METRICS_PORT` (9100). Aucune dépendance
  npm. Démarrage : `node worker.js`.
- **votre worker** (si votre sujet le demande) : **à écrire**, dans un dossier à vous (par exemple
  `worker-python/`, `worker-java/`…). Même contrat que le worker Node : mêmes variables, mêmes routes,
  même physique (mode avancé compris), même résultat à 1e-3 près, même arrêt propre ; et, si votre
  sujet demande la supervision, **mêmes métriques** (noms identiques, label
  `lang="<votre langage>"`) sur le port 9100. Son champ `lang` est le nom de son
  langage en minuscules (`"python"`, `"java"`, `"go"`…) : c'est lui qui apparaît dans le front, dans
  `/api/stats` et dans les métriques. Le format texte de Prometheus peut s'écrire à la main.
- **front** : deux temps.
  1. **Construire** (image `node:22`) : `npm ci` puis `npm run build` → `dist/`.
  2. **Servir** (image `nginx`) : copier `dist/` dans `/usr/share/nginx/html` et
     `nginx/default.conf.template` dans `/etc/nginx/templates/`. Au démarrage, l'image nginx
     remplace `${GATEWAY_URL}` : nginx relaie alors `/api/` à la gateway.
  Dans la liste des galaxies, **✦** envoie des particules dans une galaxie et **➶** y tire une
  particule lourde (voir « Les interactions de l'utilisateur »).
  Le bouton **« Charge ×5 »** crée 5 galaxies de 2000 corps : elles attendent un worker, de quoi
  faire réagir un autoscaler. Le champ **« Graine »** fixe la graine (vide = au hasard).

## Le protocole d'un worker

```
boucle :
  POST /api/galaxies/claim {worker, lang}       204 → attendre POLL_MS, recommencer
                                                200 → {galaxy, state}
  tant que step < steps (et pas de SIGTERM) :
    GET /api/galaxies/<id>/interactions?worker=<nom>
        200 [{id, type, pos, vel, mass}] → ajouter ces corps à la galaxie (souvent [] : rien à faire)
        409 → la galaxie n'est plus à vous : abandonner, claim
    [INTERACTIONS=1 : GET /api/galaxies/field]
    un pas de toute la galaxie ; attendre STEP_DELAY_MS
    PUT /api/galaxies/<id>/state {worker, lang, ms, step, t, pos, vel[, mass]}
        (ms = temps de CALCUL du pas, en millisecondes, sans le champ ni STEP_DELAY_MS ;
         mass = toutes les masses, OBLIGATOIRE si des corps ont été ajoutés depuis le PUT précédent)
        204 ok (le bail est renouvelé) · 409 reprise par un autre · 404 supprimée → abandonner, claim
  SIGTERM : finir le pas, POST /api/galaxies/<id>/release {worker}, quitter
```

La galaxie reçue :

```json
{"galaxy": {"id": "…", "n": 2000, "steps": 2000, "dt": 0.03, "eps": 0.2,
            "model": "disque", "seed": 42, "center": [12, 0, 0]},
 "state":  {"step": 120, "t": 3.6, "pos": [x0, y0, z0, x1, …], "vel": [vx0, …], "mass": [m0, …]}}
```

Les données sont **plates** : `pos = [x0, y0, z0, x1, y1, z1, …]` (3 × n nombres), de même `vel` ;
`mass` a n nombres. Chaque `PUT …/state` doit donner le pas **suivant** (400 sinon). C'est ce PUT qui
renouvelle le bail : un worker gelé ou tué perd sa galaxie au bout de `LEASE_MS`. Logs attendus :
« worker <nom> prêt », « galaxie <id> adoptée au pas k », « galaxie <id> terminée ».

## Les interactions de l'utilisateur

Depuis le front, l'utilisateur peut **envoyer des particules** dans une galaxie (un nuage qui arrive
du bord vers le centre) ou **tirer une particule** (un corps lourd lancé de loin, qui la traverse) :

```sh
curl -X POST localhost:3000/api/galaxies/<id>/interactions -H 'content-type: application/json' \
     -d '{"type":"particules","count":50}'     # count : 1 à 500 (50 par défaut)
curl -X POST localhost:3000/api/galaxies/<id>/interactions -H 'content-type: application/json' \
     -d '{"type":"tir","speed":2,"mass":0.3}'  # speed 0,1 à 10 ; mass 0,001 à 5
# → 202 {"id": "…", "type": "tir", "bodies": 1} · 404 galaxie inconnue · 409 galaxie terminée ou en erreur
```

Le chemin d'une interaction :

1. la **gateway** fabrique les corps à ajouter (positions, vitesses, masses, autour du centre de
   masse actuel de la galaxie) mais **ne touche pas à l'état** de la galaxie : elle **dépose**
   l'interaction dans la file de cette galaxie, gardée par le **store** ;
2. le **worker qui calcule la galaxie** (celui qui tient son bail, et lui seul : les autres
   reçoivent 409) la **récupère** avant son pas suivant, avec
   `GET /api/galaxies/<id>/interactions?worker=<nom>` : la file est vidée d'un coup ;
3. le worker **ajoute** les corps reçus à la fin de sa galaxie (`pos`, `vel`, `mass` concaténés,
   dans l'ordre reçu), calcule le pas avec eux, puis joint `mass` à son `PUT …/state` : la gateway
   met alors à jour `n`.

Une galaxie en attente ou en pause garde ses interactions dans la file : le worker qui l'adopte
ensuite les applique. Si un worker meurt entre la récupération et son PUT, ces corps sont perdus
(l'état du store reste cohérent).

## La physique : le contrat entre les workers

Tous les workers doivent calculer **la même chose** (à 1e-3 près) : une galaxie commencée par le
worker Node peut être reprise par le vôtre, et inversement. G = 1 ; `eps` est un petit adoucissement (il
évite les forces infinies quand deux corps se frôlent). Pour chaque corps `i` de la galaxie :

```
a_i  = Σ_{j≠i}  m_j · (r_j − r_i) / (|r_j − r_i|² + eps²)^(3/2)
v_i += a_i · dt          puis          r_i += v_i · dt      (avec le NOUVEAU v_i : Euler symplectique)
```

Résultat arrondi à **5 décimales**. **Mode avancé** (`INTERACTIONS=1`) : avant chaque pas, le worker
lit `GET /api/galaxies/field` (`[{id, com, mass}]` : centre de masse et masse de chaque galaxie) et
ajoute, pour chaque **autre** galaxie `g` : `a_i += M_g · (c_g − r_i) / (|c_g − r_i|² + 1)^(3/2)`.

## Les modèles de galaxie : créés par la gateway

La gateway crée l'état initial (le pas 0) de **toutes** les galaxies, en 3D, autour du centre de leur
case : `disque`, `elliptique`, `anneau`, `collision` (une ou deux masses centrales et des petits
corps en orbite), `random` (boule uniforme d'étoiles au repos, qui s'effondre), `plummer` (amas
sphérique à l'équilibre) et `double-spirale` (bulbe + deux bras spiraux). Même graine (`seed`), même galaxie. Le
worker reçoit toujours un `state` complet : il ne fait que simuler.

## Comparer les langages (si votre sujet le demande)

Le front affiche, **pour chaque langage**, le débit (« pas/s ») et le temps de calcul d'un pas
(« ms/pas », mesuré par le worker, sans `STEP_DELAY_MS`). `GET /api/stats` les donne en JSON :

```sh
curl -s http://<adresse>/api/stats
# → {…, "langs": {"node": {"running": 1, "workers": 1, "msPerStep": 3.1},
#                 "python": {"running": 1, "workers": 1, "msPerStep": 14.8}}, …}
```

Créez 6 galaxies de 1000 corps (même graine), puis choisissez à la main quel worker vous répliquez :

| Réplicas `worker-node` | Réplicas de votre worker | en cours | en attente | pas/s node | pas/s autre | ms/pas node | ms/pas autre |
|------------------------|--------------------------|----------|------------|------------|-------------|-------------|--------------|
| 1                      | 0                        |          |            |            |             |             |              |
| 0                      | 1                        |          |            |            |             |             |              |
| 1                      | 1                        |          |            |            |             |             |              |
| 3                      | 0                        |          |            |            |             |             |              |
| 0                      | 3                        |          |            |            |             |             |              |
| 3                      | 3                        |          |            |            |             |             |              |

## Simuler une charge sur la gateway (si votre sujet le demande)

Le simulateur de charge est **à écrire vous-même**. Outil proposé : **[Locust](https://locust.io)** (un
fichier Python décrit ce que fait un utilisateur ; Locust en lance autant que voulu et mesure tout) ;
un autre outil est possible s'il est justifié.
Il simule des navigateurs qui relisent l'univers en boucle (`GET /api/universe`, comme le front) et
doit pouvoir saturer la gateway. Il mesure, au fil du temps : le débit (requêtes par seconde), les
temps de réponse (au moins p50 et p95), les erreurs, et quelles gateways ont répondu (champ `pod` de
chaque réponse) ; à la fin, il donne un résumé en JSON.

La charge dépend des galaxies en cours : plus il y a de corps, plus l'univers à envoyer est lourd.

## Les métriques

| Métrique                                  | Où           | Sens |
|-------------------------------------------|--------------|------|
| `nbody_galaxies{status}`                  | gateway      | galaxies par statut : `running`, `waiting`, `finished`, `error` |
| `nbody_queue_length`                      | gateway      | galaxies qui attendent un worker : **la charge** |
| `nbody_galaxies_created_total`            | gateway      | galaxies créées par cette gateway |
| `nbody_steps_total{lang}`                 | gateway      | pas rendus à cette gateway, par langage de worker |
| `nbody_http_requests_total{method,route,code}` | gateway | requêtes HTTP |
| `nbody_gateway_*`                         | gateway      | métriques par défaut de Node (CPU, mémoire…) |
| `nbody_worker_steps_total{lang}`          | workers      | pas calculés |
| `nbody_worker_step_seconds{lang}`         | workers      | durée de calcul d'un pas (histogramme, en secondes) |
| `nbody_worker_busy{lang}`                 | workers      | 1 si le worker simule une galaxie, 0 s'il attend |

## Lancer sans Docker (pour comprendre)

Quatre terminaux, Node 22 (et le langage de votre worker) :

```sh
cd store   && npm install && DATA_DIR=./data node server.js
cd gateway && npm install && STORE_URL=http://localhost:4000 node server.js
cd worker-node && GATEWAY_URL=http://localhost:3000 node worker.js
cd front   && npm install && npm run dev        # http://localhost:5173
```

Plusieurs workers sur la même machine : donnez à chacun **son nom** et **son port de métriques**
(sinon ils prennent tous les deux le nom de la machine et le port 9100) :

```sh
cd worker-node && WORKER_NAME=node-1 METRICS_PORT=9101 GATEWAY_URL=http://localhost:3000 node worker.js
cd worker-node && WORKER_NAME=node-2 METRICS_PORT=9102 GATEWAY_URL=http://localhost:3000 node worker.js
```

Dans Kubernetes, rien à faire : chaque pod a son nom et son propre port 9100.

Interagir avec une galaxie, dans le front : **clic** sur une galaxie = tirer une particule ;
**Alt + clic** = envoyer des particules (aussi les boutons ✦ et ➶ de la liste). Il faut qu'un worker
calcule la galaxie pour que l'interaction s'applique.

## L'API

```sh
curl localhost:3000/api/health
curl -X POST localhost:3000/api/galaxies -H 'content-type: application/json' \
     -d '{"model":"disque","n":2000,"steps":2000}'      # → {"id": "...", "slot": 0, "center": [0,0,0]}
curl localhost:3000/api/galaxies                        # → [{id, status, step, worker, lang, ms, seed, …}]
curl localhost:3000/api/universe                        # → {galaxies: [… + pos], pod}
curl localhost:3000/api/stats                           # → {galaxies, running, waiting, finished, error, workers, langs, pod}
curl localhost:3000/metrics
```

Paramètres de `POST /api/galaxies` : `model` (`disque` | `elliptique` | `anneau` | `collision` | `random` | `plummer` | `double-spirale`), `radius` (1 à 5), `tilt` (0 à 180°),
`spin` (±1), `name`, `n` (50 à
**20 000** corps), `steps` (1 à 100 000 ; 2000 par défaut), `dt` (≤ 0,2 ; 0,03 par défaut),
`eps` (≤ 1 ; 0,2 par défaut), `seed` (entier ; même graine = même galaxie). La galaxie prend la
**première case libre** : case k → centre `((k mod 4)·12, −floor(k/4)·12, 0)`.

| Méthode | Route                                      | Qui l'appelle | Rôle                               |
|---------|--------------------------------------------|---------------|------------------------------------|
| GET     | `/api/health`                              | sondes, front | la gateway et le store vont bien ? |
| GET     | `/api/stats`                               | vous, front   | galaxies par statut, workers actifs, perfs par langage (`langs`) |
| GET     | `/api/galaxies`                            | vous          | les galaxies (statut `running`, `waiting`, `paused`, `finished`, `error`) |
| POST    | `/api/galaxies`                            | front         | crée une galaxie (catalogue : `model`, `radius`, `tilt`, `spin`, `name`, `seed`) ; 400 si un paramètre est invalide |
| GET     | `/api/workers`                             | front         | les workers vivants, au travail ou libres |
| POST    | `/api/galaxies/:id/pause` · `/resume`      | front         | arrête la simulation · la relance au même pas |
| DELETE  | `/api/galaxies/:id` · `/api/galaxies`      | front         | efface une galaxie · tout l'univers |
| GET     | `/api/universe`                            | front         | toutes les galaxies avec leurs corps (ce que dessine le front) |
| POST    | `/api/galaxies/:id/interactions`           | front         | dépose une interaction (`particules`, `tir`) : 202 |
| POST    | `/api/galaxies/claim`                      | workers       | adopte une galaxie (204 = aucune de libre) |
| PUT     | `/api/galaxies/:id/state`                  | workers       | rend un pas (409/404 = galaxie perdue) |
| POST    | `/api/galaxies/:id/release`                | workers       | rend la galaxie (à l'arrêt)        |
| POST    | `/api/galaxies/:id/error`                  | workers       | cas anormal : le worker ne sait pas simuler la galaxie → `error` |
| GET     | `/api/galaxies/field`                      | workers       | masse et centre de chaque galaxie (`INTERACTIONS=1`) |
| GET     | `/api/galaxies/:id/interactions?worker=…`  | workers       | récupère les interactions en attente (409 si pas le titulaire du bail) |
| GET     | `/metrics`                                 | Prometheus    | métriques                          |

## Ce qui est attendu

**Votre sujet (PDF)** donne les attendus, les étapes et les vérifications de votre niveau. Pour
tous : chaque service dans un conteneur, tout tourne dans le cluster, avec une seule entrée depuis
l'extérieur (`/api` vers la gateway, `/` vers le front), et le store à un réplica dont les données
survivent.
