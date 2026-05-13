# port-range

A self-contained container terminal simulation built as a red-team /
blue-team training range. A small port runs on its own: ships hail the
harbour, berths and quay cranes work them, lorries move containers in
and out of the yard through the gate. The blue team operates it; the red
team has to find ways to break it.

## What it does

A FastAPI service runs a live simulation of an eight-crane, four-berth
container terminal. The state is exposed three ways:

* a session-authenticated operator dashboard (single page, live over
  WebSocket)
* a small JSON API for state reads and operator commands
* a public `/health` probe used by the orchestrator

The blue team's score is the count of containers that complete a full
import or export move before each ship's service deadline. Pressure comes
from three places, all natural to terminal operations:

* **arrival burstiness** — sometimes ships pile up faster than berths free
* **service deadlines** — ships leave on schedule whether or not they're done
* **equipment wear** — cranes drop into unscheduled maintenance windows

If the operator allocates poorly — or if the red team disrupts
operations — containers miss the boat. Literally.

## How it works

The simulation runs as an asyncio task inside the FastAPI process. Each
tick (default 1 second of wall time) the model advances through:

1. **Ship spawn** — if the next-arrival tick has been reached, queue a new
   ship with a randomised manifest (imports + exports across 20ft, 40ft,
   40HC, reefer and tank container types).
2. **Berth assignment** — any open berth pulls the next queued ship and
   starts a randomised docking timer.
3. **Crane work** — idle cranes start the next lift on their berth's ship;
   busy cranes count down their cycle. A move is credited only when the
   cycle completes, so two cranes can't both claim the last container.
4. **Gate trucks** — lorries arrive at the gate at a rate scaled to crane
   throughput, dropping export containers in the yard and collecting
   imports for inland delivery.
5. **Departures and deadlines** — fully-worked ships cast off and credit
   their moves; ships that hit their service deadline sail with whatever
   cargo is still on board, counting against the score.
6. **Maintenance** — occasionally a crane drops offline for an unscheduled
   maintenance window, raising an alarm that the operator must acknowledge.

The operator's job is to intervene: reassign idle cranes to busier berths,
take a berth in or out of service, expedite a slow docking, and clear
alarms. Every command runs through a CSRF-protected POST and is logged
in the event feed with the operator's username.

## Architecture

```
port-range/
├── docker-compose.yml         # single hardened container
├── .env.example
├── scripts/
│   └── generate-secrets.sh    # generates random session + operator secrets
└── services/
    └── control/
        ├── app.py             # FastAPI: routes, auth, websocket, sim hookup
        ├── simulation.py      # tick loop, ships, berths, cranes, gate, score
        ├── templates/         # login.html, dashboard.html (Jinja2)
        ├── static/            # dashboard.css, dashboard.js (no CDN)
        ├── Dockerfile
        └── requirements.txt
```

The container runs as a non-root user with a read-only filesystem, no
capabilities, and `no-new-privileges`. It publishes to `127.0.0.1:18090`
by default, so the only public path in is whatever reverse proxy or
tunnel you put in front of it.

## Running

```bash
cd /var/www/port-range
./scripts/generate-secrets.sh        # writes .env with random secrets
$EDITOR .env                          # set PORT_OPERATOR_USERNAME at minimum
docker compose build
docker compose up -d
curl http://127.0.0.1:18090/health    # → {"status":"ok"}
```

The generated `.env` contains the operator password in cleartext at mode
600. Read it once and store it in your password manager — the dashboard
never re-displays it.

## Operator commands

All four are CSRF-protected and require a valid session. Each appears in
the event log attributed to the operator who issued it.

* **reassign crane** — move an idle crane to a different berth. The new
  berth starts using it on the next tick.
* **berth status** — open or close a berth. Closing a berth through the
  operator UI requires it to be empty first.
* **expedite docking** — skip the remaining docking timer for a ship
  that is still manoeuvring.
* **acknowledge alarm** — clear an active alarm row.

## Red team brief — vulnerability surface

The operator login and dashboard are reasonably solid: rate-limited
login, signed sessions (`itsdangerous`, 8h TTL), CSRF on every
state-changing call, strict CSP, secure cookies, container hardening.
**The deliberate weaknesses are not in the login path.** Red team will
need to look at what's *next to* the operator dashboard, not at it
head-on.

### Disruption goals

Anything that costs the blue team score, hides what's happening, or
makes operator response slower:

* **Force ships out before they're worked** — every container left on
  board when a ship leaves counts as a missed move.
* **Take berths out of service while occupied** — displaces any ship
  alongside and fails its remaining cargo, then keeps that berth offline
  so the queue backs up.
* **Inject false alarms** — bury real alarms in noise, or trigger
  responses the operator wastes time investigating.
* **Acknowledge alarms the operator hasn't seen** — hide real
  equipment failures from the operator's view.
* **Forge operator actions** — issue commands attributed to a name
  that isn't the legitimate operator, so the event log misattributes
  cause and effect when blue team does forensics.

### Where to look

Two classes of weakness sit on the box. Both are common in industrial
supply-chain software and both have been left in the deployment
intentionally for this exercise.

1. **Legacy vendor remote-support API.** The terminal control software
   shipped with a privileged diagnostic interface the vendor used for
   outage support. It bypasses the operator login entirely; a static
   token is the only thing standing between the open internet and full
   port control. Standard reconnaissance — path enumeration, source
   inspection, traffic capture — will find both the endpoint and the
   token. Once you have them, every disruption goal in the list above
   is reachable in a single HTTP request.

2. **Verbose diagnostic endpoint.** A debug / monitoring route was left
   exposed during deployment. It returns more than it should — enough
   that an attacker who finds it can mint a session for the legitimate
   operator account and call any authenticated endpoint as the operator,
   indistinguishable in the event log from the real user.

### What blue team gets to detect with

The event log, the alarm list, and the score history are all the blue
team's friends. Forced berth closures, force-released ships, and
injected alarms all leave traces in the event feed — attributed, by
default, to a service principal. Whether they catch on before the
ship sails is the exercise.

## Tuning

Edit `.env`:

| Variable                  | Default | Effect                              |
|---------------------------|---------|-------------------------------------|
| `PORT_TICK_SECONDS`       | 1.0     | wall-time per sim tick              |
| `PORT_BERTHS`             | 4       | total berths                        |
| `PORT_CRANES_PER_BERTH`   | 2       | initial crane allotment per berth   |
| `PORT_CRANE_CYCLE_TICKS`  | 5       | base ticks per container move       |

Lowering `PORT_TICK_SECONDS` runs the scenario faster — useful for short
exercises.

## Resetting

```bash
docker compose down && docker compose up -d
```

The simulation has no on-disk state — restarting wipes the scoreboard,
the event log, and any in-flight ships. That's intentional; scenarios
are meant to be reset between exercises.
