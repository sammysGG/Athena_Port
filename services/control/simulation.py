"""
Port operations simulation.

A self-running model of a small container terminal: ships queue offshore,
berths and cranes process them, trucks move containers in and out through
the gate. The blue team's score is the count of containers that complete a
full import or export move before their ship's service deadline expires.

Pressure comes from three places, all natural to terminal ops:
  * arrival burstiness — sometimes ships pile up faster than berths free up
  * service deadlines — a ship leaves on schedule whether or not it's done
  * equipment wear — cranes need short maintenance windows at random

The operator's job is to reassign cranes between berths, take berths in and
out of service for unscheduled maintenance, and acknowledge alarms. Bad
allocation makes containers miss the boat — literally.
"""

from __future__ import annotations

import asyncio
import random
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Optional


SHIP_NAMES = [
    "MV Albatross", "MV Beacon", "MV Cygnus", "MV Delphi", "MV Estuary",
    "MV Fjord", "MV Gannet", "MV Halyard", "MV Iberis", "MV Juno",
    "MV Kestrel", "MV Larkspur", "MV Mistral", "MV Nautilus", "MV Orion",
    "MV Pelagia", "MV Quasar", "MV Rorqual", "MV Stratos", "MV Tradewind",
    "MV Ursa", "MV Vela", "MV Westerly", "MV Xebec", "MV Yarrow", "MV Zenith",
]

# Container type breakdown — weights are the population share, used when the
# ship's manifest is generated and when picking a type to lift each cycle.
CONTAINER_TYPES = [
    ("20ft",   0.42),
    ("40ft",   0.32),
    ("40HC",   0.14),
    ("reefer", 0.08),
    ("tank",   0.04),
]


def _now() -> float:
    return time.time()


@dataclass
class Berth:
    id: int
    status: str = "open"            # open | occupied | closed
    ship_id: Optional[str] = None


@dataclass
class Crane:
    id: str
    berth_id: int
    status: str = "idle"            # idle | busy | maintenance
    busy_until_tick: int = 0
    last_action: str = ""
    work_dir: str = ""              # "" | import | export — what it's lifting right now
    work_type: str = ""             # container type currently in the spreader
    cycle_total: int = 0            # ticks the current cycle was set to (for UI progress)


@dataclass
class Ship:
    id: str
    name: str
    arrived_tick: int
    deadline_tick: int
    imports_remaining: int
    exports_remaining: int
    total_imports: int
    total_exports: int
    status: str = "queued"          # queued | docking | working | departing | departed
    berth_id: Optional[int] = None
    state_until_tick: int = 0
    # per-type breakdown
    import_types_orig: dict = field(default_factory=dict)
    export_types_orig: dict = field(default_factory=dict)
    import_types: dict = field(default_factory=dict)
    export_types: dict = field(default_factory=dict)


@dataclass
class Event:
    tick: int
    ts: float
    level: str                      # info | warn | alarm
    text: str


class PortSimulation:
    def __init__(
        self,
        *,
        tick_seconds: float = 1.0,
        n_berths: int = 4,
        cranes_per_berth: int = 2,
        crane_cycle_ticks: int = 5,
        history_size: int = 600,
        event_size: int = 400,
        seed: Optional[int] = None,
    ):
        self.tick_seconds = tick_seconds
        self.tick: int = 0
        self.started_at: float = _now()
        self._rng = random.Random(seed)
        self.crane_cycle_ticks = max(1, int(crane_cycle_ticks))

        self.berths: list[Berth] = [Berth(id=i + 1) for i in range(n_berths)]
        self.cranes: list[Crane] = []
        for berth in self.berths:
            for k in range(cranes_per_berth):
                self.cranes.append(Crane(id=f"C{berth.id}-{k+1}", berth_id=berth.id))

        self.ships: dict[str, Ship] = {}
        self.queue: list[str] = []          # ship ids waiting offshore
        self._next_ship_at_tick: int = 30
        self._ship_counter: int = 0
        # Trucks accumulate fractionally so the average arrival rate stays
        # below one per tick without sometimes-zero, sometimes-burst variance.
        self._truck_accum: float = 0.0

        self.yard_imports: int = 0          # offloaded, awaiting truck pickup
        self.yard_exports: int = 0          # dropped by trucks, awaiting load

        self.score_imports: int = 0
        self.score_exports: int = 0
        self.missed_imports: int = 0
        self.missed_exports: int = 0
        self.ships_completed: int = 0
        self.ships_failed: int = 0

        self.events: deque[Event] = deque(maxlen=event_size)
        self.alarms: dict[str, dict] = {}   # key -> {text, since_tick, level}
        self.throughput_window: deque[int] = deque(maxlen=60)  # moves per tick
        self.score_history: deque[dict] = deque(maxlen=history_size)

        self._lock = asyncio.Lock()
        self._stop = asyncio.Event()
        self._task: Optional[asyncio.Task] = None
        self._moves_this_tick = 0

        self._emit("info", "Terminal control system initialised.")

    # ── lifecycle ────────────────────────────────────────────────────────────

    async def start(self) -> None:
        if self._task is not None:
            return
        self._task = asyncio.create_task(self._run(), name="port-sim")

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            await self._task
            self._task = None

    async def _run(self) -> None:
        while not self._stop.is_set():
            try:
                await self._step()
            except Exception as exc:  # pragma: no cover — defensive
                self._emit("alarm", f"Simulation error: {exc!r}")
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self.tick_seconds)
            except asyncio.TimeoutError:
                pass

    # ── per-tick logic ───────────────────────────────────────────────────────

    async def _step(self) -> None:
        async with self._lock:
            self.tick += 1
            self._moves_this_tick = 0

            self._maybe_announce_ship()
            self._maybe_assign_berths()
            self._advance_dockings()
            self._work_cranes()
            self._gate_trucks()
            self._advance_departures()
            self._enforce_deadlines()
            self._random_crane_maintenance()

            self.throughput_window.append(self._moves_this_tick)
            self.score_history.append({
                "tick": self.tick,
                "imports": self.score_imports,
                "exports": self.score_exports,
                "missed": self.missed_imports + self.missed_exports,
                "moves": self._moves_this_tick,
            })

    def _maybe_announce_ship(self) -> None:
        if self.tick < self._next_ship_at_tick:
            return
        self._spawn_ship()
        # Arrival cadence scaled to crane throughput. With 2 cranes/berth at
        # cycle=5t, each berth finishes ~0.4 containers/tick. A 4-berth port
        # averages ~1.6 moves/tick; a ship that's ~150 containers needs ~190t
        # of work plus dock/leave. So arrivals every ~90..210t keeps queues
        # honest without instantly flooding.
        self._next_ship_at_tick = self.tick + self._rng.randint(90, 210)

    def _spawn_ship(self) -> None:
        self._ship_counter += 1
        sid = f"S{self._ship_counter:04d}"
        name = self._rng.choice(SHIP_NAMES)
        imports = self._rng.randint(25, 110)
        exports = self._rng.randint(20, 90)
        total = imports + exports
        # Deadline budget: ~1.5 container-equivalents per move (2 cranes,
        # cycle_ticks per move, alternation overhead) + dock/depart + slack.
        per_move = self.crane_cycle_ticks * 0.7
        service_budget = int(total * per_move) + self._rng.randint(80, 160)
        import_types = self._distribute_types(imports)
        export_types = self._distribute_types(exports)
        ship = Ship(
            id=sid, name=name,
            arrived_tick=self.tick,
            deadline_tick=self.tick + service_budget,
            imports_remaining=imports,
            exports_remaining=exports,
            total_imports=imports,
            total_exports=exports,
            import_types_orig=dict(import_types),
            export_types_orig=dict(export_types),
            import_types=dict(import_types),
            export_types=dict(export_types),
        )
        self.ships[sid] = ship
        self.queue.append(sid)
        self._emit("info", f"{name} ({sid}) hailed port — {imports} imp / {exports} exp, ETA dock pending.")

    def _distribute_types(self, total: int) -> dict[str, int]:
        names = [t for t, _ in CONTAINER_TYPES]
        weights = [w for _, w in CONTAINER_TYPES]
        bucket = {t: 0 for t in names}
        for _ in range(total):
            bucket[self._rng.choices(names, weights=weights, k=1)[0]] += 1
        return bucket

    def _pop_type(self, types: dict[str, int]) -> Optional[str]:
        avail = [(t, c) for t, c in types.items() if c > 0]
        if not avail:
            return None
        names = [t for t, _ in avail]
        weights = [c for _, c in avail]
        chosen = self._rng.choices(names, weights=weights, k=1)[0]
        types[chosen] -= 1
        return chosen

    def _maybe_assign_berths(self) -> None:
        for berth in self.berths:
            if berth.status != "open":
                continue
            if not self.queue:
                return
            sid = self.queue.pop(0)
            ship = self.ships[sid]
            berth.status = "occupied"
            berth.ship_id = sid
            ship.berth_id = berth.id
            ship.status = "docking"
            ship.state_until_tick = self.tick + self._rng.randint(8, 16)
            self._emit("info", f"{ship.name} cleared for berth {berth.id}, docking…")

    def _advance_dockings(self) -> None:
        for ship in self.ships.values():
            if ship.status == "docking" and self.tick >= ship.state_until_tick:
                ship.status = "working"
                self._emit("info", f"{ship.name} secured at berth {ship.berth_id}, cargo ops commencing.")

    def _work_cranes(self) -> None:
        for crane in self.cranes:
            if crane.status == "maintenance":
                if self.tick >= crane.busy_until_tick:
                    crane.status = "idle"
                    crane.last_action = "returned from maintenance"
                continue

            # A crane mid-cycle stays mid-cycle. When the cycle ends, the
            # container actually lands and the score updates.
            if crane.status == "busy":
                if self.tick < crane.busy_until_tick:
                    self._moves_this_tick += 0  # progress, no score yet
                    continue
                # cycle complete
                berth = self.berths[crane.berth_id - 1]
                if berth.ship_id is not None and berth.ship_id in self.ships:
                    ship = self.ships[berth.ship_id]
                    if crane.work_dir == "import":
                        # imports_remaining was already decremented at cycle
                        # start (reservation). Now credit the move.
                        self.yard_imports += 1
                        self._moves_this_tick += 1
                        crane.last_action = f"discharged container ex {ship.name}"
                    elif crane.work_dir == "export":
                        # exports_remaining and yard_exports were both
                        # decremented at cycle start. Credit the score.
                        self.score_exports += 1
                        self._moves_this_tick += 1
                        crane.last_action = f"loaded export → {ship.name}"
                    if ship.imports_remaining == 0 and ship.exports_remaining == 0 and ship.status == "working":
                        # only declare departing if no other crane is still
                        # mid-cycle on this ship — otherwise we'd cast off
                        # while a container is still in the air.
                        others = [c for c in self.cranes if c.berth_id == berth.id and c.status == "busy" and c is not crane]
                        if not others:
                            ship.status = "departing"
                            ship.state_until_tick = self.tick + self._rng.randint(6, 12)
                            self._emit("info", f"{ship.name} fully worked at berth {ship.berth_id}, casting off.")
                crane.status = "idle"
                crane.work_dir = ""
                crane.work_type = ""
                crane.cycle_total = 0
                continue

            # idle — see if there's work to start
            berth = self.berths[crane.berth_id - 1]
            if berth.status != "occupied" or berth.ship_id is None:
                crane.last_action = "standby"
                continue
            ship = self.ships[berth.ship_id]
            if ship.status != "working":
                crane.last_action = f"awaiting {ship.name}"
                continue

            if ship.imports_remaining > 0:
                # Reserve at cycle-start so two cranes don't both claim the
                # last container. The move is credited (score + yard) only
                # when the cycle finishes.
                ship.imports_remaining -= 1
                ctype = self._pop_type(ship.import_types) or ""
                self._begin_crane_cycle(crane, "import", ctype)
                crane.last_action = f"lifting {ctype} import ← {ship.name}"
            elif ship.exports_remaining > 0 and self.yard_exports > 0:
                ship.exports_remaining -= 1
                self.yard_exports -= 1
                ctype = self._pop_type(ship.export_types) or ""
                self._begin_crane_cycle(crane, "export", ctype)
                crane.last_action = f"swinging {ctype} export → {ship.name}"
            else:
                crane.last_action = "waiting on yard export stock" if ship.exports_remaining > 0 else "ship workdone"

    def _begin_crane_cycle(self, crane: Crane, direction: str, container_type: str = "") -> None:
        # Small per-cycle jitter so the cranes don't beat in lockstep.
        jitter = self._rng.randint(-1, 1)
        cycle = max(2, self.crane_cycle_ticks + jitter)
        crane.status = "busy"
        crane.work_dir = direction
        crane.work_type = container_type
        crane.busy_until_tick = self.tick + cycle
        crane.cycle_total = cycle

    def _gate_trucks(self) -> None:
        # Arrival rate scaled to crane throughput. At cycle=5t with 8 cranes
        # the port discharges ~1.6 containers/tick; gate pickup needs to be
        # in the same ballpark or the yard saturates instantly.
        rate = 1.4 / max(1.0, self.crane_cycle_ticks / 4.0)
        # jittered fractional accumulator → at most a couple trucks per tick
        self._truck_accum += self._rng.uniform(rate * 0.4, rate * 1.6)
        truck_arrivals = int(self._truck_accum)
        self._truck_accum -= truck_arrivals
        for _ in range(truck_arrivals):
            roll = self._rng.random()
            if roll < 0.55 and self.yard_imports > 0:
                self.yard_imports -= 1
                self.score_imports += 1
            elif roll < 0.95:
                self.yard_exports += 1
            # else: truck departs empty (admin)

    def _advance_departures(self) -> None:
        for ship in list(self.ships.values()):
            if ship.status == "departing" and self.tick >= ship.state_until_tick:
                self._release_ship(ship, reason="completed")

    def _enforce_deadlines(self) -> None:
        for ship in list(self.ships.values()):
            if ship.status in ("departed",):
                continue
            if self.tick < ship.deadline_tick:
                continue
            # Ship is timing out. Anything left on board is "missed".
            missed_i = ship.imports_remaining
            missed_e = ship.exports_remaining
            self.missed_imports += missed_i
            self.missed_exports += missed_e
            ship.imports_remaining = 0
            ship.exports_remaining = 0
            self._emit(
                "alarm" if (missed_i + missed_e) > 20 else "warn",
                f"{ship.name} sailed past service deadline — {missed_i} imp + {missed_e} exp missed.",
            )
            self._release_ship(ship, reason="deadline")

    def _release_ship(self, ship: Ship, *, reason: str) -> None:
        if ship.berth_id is not None:
            berth = self.berths[ship.berth_id - 1]
            if berth.ship_id == ship.id:
                berth.ship_id = None
                berth.status = "open" if berth.status != "closed" else "closed"
        if reason == "completed":
            self.ships_completed += 1
            self._emit("info", f"{ship.name} departed clean. +{ship.total_imports + ship.total_exports} moves credited.")
        else:
            self.ships_failed += 1
        ship.status = "departed"
        ship.berth_id = None
        # Keep the record briefly for the UI; cull after a while.
        if len(self.ships) > 80:
            # remove oldest departed
            for k, s in list(self.ships.items()):
                if s.status == "departed":
                    del self.ships[k]
                    break

    def _random_crane_maintenance(self) -> None:
        # ~1 maintenance event per crane per ~1500 ticks
        for crane in self.cranes:
            if crane.status == "maintenance":
                continue
            if self._rng.random() < 1 / 1500:
                crane.status = "maintenance"
                crane.busy_until_tick = self.tick + self._rng.randint(30, 90)
                crane.last_action = "unscheduled maintenance"
                key = f"crane-maint-{crane.id}"
                self.alarms[key] = {
                    "text": f"Crane {crane.id} dropped offline for maintenance.",
                    "since_tick": self.tick,
                    "level": "warn",
                }
                self._emit("warn", f"Crane {crane.id} unscheduled maintenance ({crane.busy_until_tick - self.tick} ticks).")

    # ── operator commands ────────────────────────────────────────────────────

    async def reassign_crane(self, crane_id: str, berth_id: int, actor: str) -> dict:
        async with self._lock:
            for crane in self.cranes:
                if crane.id == crane_id:
                    if crane.status == "maintenance":
                        return {"ok": False, "error": "crane in maintenance"}
                    if not any(b.id == berth_id for b in self.berths):
                        return {"ok": False, "error": "no such berth"}
                    old = crane.berth_id
                    crane.berth_id = berth_id
                    crane.status = "idle"
                    crane.last_action = f"reassigned from B{old} by {actor}"
                    self._emit("info", f"Operator {actor} moved {crane.id} from B{old} → B{berth_id}.")
                    return {"ok": True}
            return {"ok": False, "error": "no such crane"}

    async def set_berth_status(self, berth_id: int, new_status: str, actor: str) -> dict:
        if new_status not in ("open", "closed"):
            return {"ok": False, "error": "status must be open or closed"}
        async with self._lock:
            for berth in self.berths:
                if berth.id != berth_id:
                    continue
                if berth.ship_id is not None and new_status == "closed":
                    return {"ok": False, "error": "berth occupied — release ship first"}
                berth.status = new_status
                self._emit("info", f"Operator {actor} set berth {berth_id} → {new_status}.")
                return {"ok": True}
            return {"ok": False, "error": "no such berth"}

    async def acknowledge_alarm(self, key: str, actor: str) -> dict:
        async with self._lock:
            if key in self.alarms:
                del self.alarms[key]
                self._emit("info", f"Operator {actor} acknowledged alarm {key}.")
                return {"ok": True}
            return {"ok": False, "error": "no such alarm"}

    async def expedite_ship(self, ship_id: str, actor: str) -> dict:
        """Skip the docking timer for a ship that's still manoeuvring."""
        async with self._lock:
            ship = self.ships.get(ship_id)
            if not ship:
                return {"ok": False, "error": "no such ship"}
            if ship.status != "docking":
                return {"ok": False, "error": f"ship is {ship.status}, not docking"}
            ship.state_until_tick = self.tick
            self._emit("info", f"Operator {actor} expedited docking for {ship.name}.")
            return {"ok": True}

    # ── snapshot for UI ──────────────────────────────────────────────────────

    def snapshot(self) -> dict:
        moves_per_min = sum(self.throughput_window)  # ~60 ticks
        active_ships = [s for s in self.ships.values() if s.status not in ("departed",)]
        active_ships.sort(key=lambda s: (s.berth_id is None, s.arrived_tick))
        return {
            "tick": self.tick,
            "uptime_seconds": int(_now() - self.started_at),
            "score": {
                "imports": self.score_imports,
                "exports": self.score_exports,
                "missed_imports": self.missed_imports,
                "missed_exports": self.missed_exports,
                "ships_completed": self.ships_completed,
                "ships_failed": self.ships_failed,
            },
            "throughput": {
                "moves_per_min": moves_per_min,
                "moves_this_tick": self._moves_this_tick,
            },
            "yard": {
                "imports_staged": self.yard_imports,
                "exports_staged": self.yard_exports,
            },
            "berths": [
                {"id": b.id, "status": b.status, "ship_id": b.ship_id}
                for b in self.berths
            ],
            "cranes": [
                {
                    "id": c.id, "berth_id": c.berth_id, "status": c.status,
                    "last_action": c.last_action, "work_dir": c.work_dir, "work_type": c.work_type,
                    "cycle_total": c.cycle_total,
                    "cycle_remaining": max(0, c.busy_until_tick - self.tick) if c.status == "busy" else 0,
                    "remaining_maint": max(0, c.busy_until_tick - self.tick) if c.status == "maintenance" else 0,
                }
                for c in self.cranes
            ],
            "ships": [
                {
                    "id": s.id, "name": s.name, "status": s.status, "berth_id": s.berth_id,
                    "imports_remaining": s.imports_remaining, "exports_remaining": s.exports_remaining,
                    "total_imports": s.total_imports, "total_exports": s.total_exports,
                    "ticks_to_deadline": s.deadline_tick - self.tick,
                    "import_types_orig": dict(s.import_types_orig),
                    "export_types_orig": dict(s.export_types_orig),
                    "import_types": dict(s.import_types),
                    "export_types": dict(s.export_types),
                    "arrived_tick": s.arrived_tick,
                    "deadline_tick": s.deadline_tick,
                }
                for s in active_ships
            ],
            "container_types": [t for t, _ in CONTAINER_TYPES],
            "queue_length": len(self.queue),
            "alarms": [{"key": k, **v} for k, v in self.alarms.items()],
            "events": [
                {"tick": e.tick, "ts": e.ts, "level": e.level, "text": e.text}
                for e in list(self.events)[-80:]
            ],
            "score_history": list(self.score_history)[-180:],
        }

    # ── helpers ──────────────────────────────────────────────────────────────

    def _emit(self, level: str, text: str) -> None:
        self.events.append(Event(tick=self.tick, ts=_now(), level=level, text=text))
