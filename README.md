# port-range

A self-driving container terminal simulation with an operator dashboard.
Separate from the `scada-range` next door — it does not share services,
networks, volumes or credentials.

## What it does

A small port runs on its own: ships hail the harbour on a random schedule,
berths and quay cranes work them, lorries move containers in and out of the
yard through the gate. The blue team's score is the number of containers
that complete an import or export move before each ship's service deadline.

Pressure comes from three places, all natural to terminal operations:

* arrival burstiness — sometimes ships pile up faster than berths free up
* service deadlines — a ship leaves on schedule whether or not it's done
* equipment wear — cranes need short unscheduled maintenance windows

The operator's job is to reassign cranes between berths, take berths out
of service for maintenance, expedite a docking that's overrunning, and
acknowledge alarms. The dashboard is a single-page terminal-style console
that ticks live over WebSocket.

## Security posture

Unlike `scada-range`, this stack has **no** intentionally-weak surfaces:

* every page and every state-changing endpoint requires a login
* sessions use signed cookies (itsdangerous, 8 h TTL); rotate
  `PORT_SESSION_SECRET` to revoke them all
* state-changing POSTs require a matching `X-CSRF-Token` header (double-
  submit pattern; the token is bound to the session)
* login is rate-limited by client IP (5 failures in 5 min → 15 min lockout)
* `PORT_OPERATOR_PASSWORD` must be ≥ 12 chars; the service refuses to
  start otherwise
* strict CSP with no inline scripts/styles, X-Frame-Options DENY, no
  referrer, no caching, HttpOnly session cookie
* container runs as a non-root user, read-only filesystem, no capabilities,
  `no-new-privileges`
* publishes only to `127.0.0.1` by default so the only public path in is
  the Cloudflare tunnel you already have running

Red team has to actually compromise the login or find a real flaw — the
range does not hand them a back door.

## First boot

```bash
cd /var/www/port-range
./scripts/generate-secrets.sh        # creates .env with random secrets
$EDITOR .env                          # at minimum set PORT_OPERATOR_USERNAME
docker compose build
docker compose up -d
```

Once healthy:

```bash
curl http://127.0.0.1:18090/health
# → {"status":"ok"}
```

The generated `.env` contains the operator password in cleartext at mode
600. Read it once and store it in your password manager; the dashboard
never re-displays it.

## Wiring to the existing Cloudflare tunnel

The existing `scada-range` stack runs cloudflared with a tunnel token.
You have two clean options:

1. **Add a new hostname to the same tunnel** (recommended). In the
   Cloudflare dashboard, on the tunnel's *Public Hostnames* tab, add an
   entry like:

   | Field    | Value                                  |
   |----------|----------------------------------------|
   | Hostname | `port.<your-domain>`                   |
   | Service  | `http://host.docker.internal:18090` *or* the host's LAN IP, e.g. `http://192.168.x.x:18090` |

   No file changes needed on the box.

2. **Path-route on the scada hostname.** Add an ingress rule before the
   scada catch-all in the tunnel config:
   `Path: /port  →  http://<host>:18090`
   The app is path-agnostic; behind a path-rewriting proxy it will work
   without code changes. (If the tunnel doesn't strip the prefix, set
   the tunnel rule to do so.)

The app binds to `127.0.0.1:18090` by default. The cloudflared container
on this host reaches it via the host network — confirm it can hit
`http://<host-lan-ip>:18090/health` before adding the hostname.

## Tuning the scenario

Edit `.env`:

| Variable                  | Default | Effect                              |
|---------------------------|---------|-------------------------------------|
| `PORT_TICK_SECONDS`       | 1.0     | wall-time per sim tick              |
| `PORT_BERTHS`             | 4       | total berths                         |
| `PORT_CRANES_PER_BERTH`   | 2       | initial crane allotment per berth    |

Tuning down `PORT_TICK_SECONDS` makes everything happen faster, which is
useful for short exercises.

## Layout

```
port-range/
├── docker-compose.yml
├── .env.example
├── scripts/
│   └── generate-secrets.sh
└── services/
    └── control/
        ├── app.py            # FastAPI: routes, auth, websocket
        ├── simulation.py     # tick loop, ships, berths, cranes, gate, score
        ├── templates/        # login.html, dashboard.html (Jinja2)
        ├── static/           # dashboard.css, dashboard.js (no CDN)
        ├── Dockerfile
        └── requirements.txt
```

## Operator commands

The dashboard exposes four actions (all authenticated, CSRF-protected):

* **reassign crane** — move an idle crane to a different berth. The new
  berth starts using it on the next tick.
* **berth status** — open or close a berth. Closing requires the berth
  to be empty; useful for taking it out for scheduled maintenance.
* **expedite docking** — skip the remaining docking timer for a ship
  that's still manoeuvring. Use when a berth has been free but the ship
  is taking too long.
* **acknowledge alarm** — clear an active alarm row.

Every command appears in the event log with the operator's username.

## Run-out / shut-down

```bash
docker compose down
```

The simulation has no on-disk state — restarting wipes the scoreboard.
That's intentional; scenarios are meant to be reset between exercises.
