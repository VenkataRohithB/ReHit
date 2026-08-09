"""In-memory quiz engine. No framework imports — pure stdlib, unit-testable.

Single-process, asyncio. ponytail: state lives in this process's memory, so run
ONE worker. Horizontal scale would need shared state (Redis) + pub/sub fan-out;
deliberately out of scope. Vertical scale is plenty — one asyncio process holds
thousands of WebSockets fine.
"""
import asyncio
import contextlib
import csv
import io
import logging
import secrets
import time

SEND_TIMEOUT = 5   # seconds before a stalled client is dropped from a broadcast


async def _hang_up(ws):
    with contextlib.suppress(Exception):
        await ws.close()


# ---------- pure scoring (unit-tested) ----------
def score_answer(correct: bool, t: float, timer: float) -> int:
    """Kahoot-style: instant-correct ~1000, last-second-correct ~500, wrong 0."""
    if not correct:
        return 0
    t = max(0.0, min(t, timer))
    return round(1000 * (1 - t / timer) / 2 + 500)


def rank_players(players):
    """Score desc, then earliest cumulative answer time as tiebreak."""
    return sorted(players, key=lambda p: (-p.score, p.total_time))


class Player:
    __slots__ = ("email", "score", "total_time", "ws", "answers")

    def __init__(self, email):
        self.email = email
        self.score = 0
        self.total_time = 0.0
        self.ws = None
        self.answers = []  # one dict per question: {option,time,correct,points}


def split_timer(total, read_secs):
    """A question's configured seconds are split into reading time and answering
    time. Reading is trimmed so there is always at least 1s left to answer."""
    read = max(0, min(read_secs, total - 1))
    return read, total - read


class Room:
    def __init__(self, code, capacity, questions, advance_timeout, title="", read_secs=0):
        self.code = code
        self.title = title
        self.capacity = capacity
        self.questions = questions
        self.read_secs = read_secs
        self.read_len = 0        # this question's reading phase
        self.answer_len = 0      # this question's answering phase — scoring uses this
        self.read_ends = 0.0
        # the host drives advancing; this is only a backstop so a host who walks
        # away cannot pin a room in memory forever
        self.advance_timeout = advance_timeout
        self.advance = asyncio.Event()
        self.players: dict[str, Player] = {}
        self.hosts = set()
        self.state = "lobby"          # lobby | question | results | ended
        self.q_index = -1
        self.q_start = 0.0
        self.q_ends = 0.0
        self.responses: dict[str, tuple] = {}
        self.all_answered = asyncio.Event()
        self.started = False
        self.task = None
        self.created = time.time()
        self.ended_at = None
        self.prev_rank: dict[str, int] = {}   # email -> rank after the previous question
        # snapshots so a reconnecting client can be put back on the right screen
        self.last_results = None
        self.last_ranks: dict[str, int] = {}
        self.final_msg = None

    # ---------- membership ----------
    def add_or_reconnect(self, email):
        """Returns (player, error_msg). error_msg is None on success.

        A known email always reconnects and keeps its score — that is what makes
        a browser refresh survivable. If a socket is still open on that player the
        caller takes it over and closes the old one; last device in wins.
        """
        existing = self.players.get(email)
        if existing is not None:
            return existing, None
        if self.state != "lobby":
            return None, "Game already started"
        if len(self.players) >= self.capacity:
            return None, "Room is full"
        p = Player(email)
        self.players[email] = p
        return p, None

    def connected_count(self):
        return sum(1 for p in self.players.values() if p.ws)

    # ---------- answering ----------
    def record_answer(self, email, opt):
        if self.state != "question" or email in self.responses:
            return
        p = self.players.get(email)
        if p is None:
            return
        t = min(max(0.0, time.time() - self.q_start), self.answer_len)
        self.responses[email] = (opt, t)
        self.check_all_answered()

    def check_all_answered(self):
        """Close the question early only when every *connected* player answered.
        Recomputed on answer AND on disconnect so a drop can't strand the room."""
        if self.state != "question" or self.connected_count() == 0:
            return
        if all((p.ws is None) or (p.email in self.responses)
               for p in self.players.values()):
            self.all_answered.set()

    # ---------- messages ----------
    def board(self, ranking, limit=15):
        """Top-N leaderboard rows with rank movement since the previous question."""
        rows = []
        for n, p in enumerate(ranking[:limit]):
            prev = self.prev_rank.get(p.email)
            rows.append({"email": p.email, "score": p.score,
                         "delta": 0 if prev is None else prev - (n + 1)})
        return rows

    def lobby_msg(self):
        return {"type": "lobby", "players": list(self.players.keys()),
                "count": len(self.players), "capacity": self.capacity,
                "state": self.state, "title": self.title}

    def question_msg(self):
        q = self.questions[self.q_index]
        reading = self.state == "reading"
        ends = self.read_ends if reading else self.q_ends
        msg = {"type": "question", "index": self.q_index,
               "total": len(self.questions), "text": q["text"],
               "phase": "reading" if reading else "answering",
               # seconds left at send time, not an absolute stamp — the client
               # counts down locally so its clock never has to match ours
               "remaining": max(0.0, round(ends - time.time(), 2)),
               "window": self.read_len if reading else self.answer_len,
               "timer": q["timer"],
               "code": q.get("code"), "image": q.get("image")}
        if not reading:
            msg["options"] = q["options"]        # withheld until the reveal
        return msg

    def results_msg_for(self, player):
        """Rebuild the results screen for someone who reconnected into it."""
        if not self.last_results:
            return None
        gained = player.answers[-1]["points"] if player.answers else 0
        return {**self.last_results, "your_score": player.score,
                "your_rank": self.last_ranks.get(player.email, 0), "gained": gained}

    def resume_msg_for(self, player):
        """Whatever screen this room is on right now, for a client rejoining it."""
        if self.state == "reading":
            return self.question_msg()
        if self.state == "question":
            msg = self.question_msg()
            if player.email in self.responses:
                msg = {**msg, "your_answer": self.responses[player.email][0]}
            return msg
        if self.state == "results":
            return self.results_msg_for(player)
        if self.state == "ended":
            return self.final_msg
        return None

    # ---------- broadcasting ----------
    async def _send(self, ws, msg):
        try:
            # a client whose connection has stalled must not hold up the room:
            # bound the wait, drop it, and let it resume when it reconnects
            await asyncio.wait_for(ws.send_json(msg), timeout=SEND_TIMEOUT)
            return True
        except Exception:
            return False

    async def _fan_out(self, targets):
        """targets: [(player, msg)] — sent concurrently so one slow phone cannot
        delay everyone behind it in the loop."""
        if not targets:
            return
        oks = await asyncio.gather(*(self._send(p.ws, m) for p, m in targets),
                                   return_exceptions=True)
        for (p, _), ok in zip(targets, oks):
            if ok is not True:
                # Forgetting the socket is not enough: the phone gets no close
                # event, so it never reconnects and sits frozen on a stale
                # question while the class moves on. Hang up properly and let
                # its client come back and resume.
                ws, p.ws = p.ws, None
                if ws is not None:
                    asyncio.create_task(_hang_up(ws))

    async def broadcast(self, msg):
        await self._fan_out([(p, msg) for p in list(self.players.values()) if p.ws])
        await self.send_hosts(msg)

    async def send_hosts(self, msg):
        for hw in list(self.hosts):
            if not await self._send(hw, msg):
                self.hosts.discard(hw)

    # ---------- game loop ----------
    async def run(self):
        try:
            for i, q in enumerate(self.questions):
                self.q_index = i
                self.responses = {}
                self.all_answered = asyncio.Event()
                self.read_len, self.answer_len = split_timer(q["timer"], self.read_secs)

                if self.read_len:
                    # question alone first — no options sent, so they cannot be
                    # read out of the payload before everyone can see them
                    self.state = "reading"
                    self.read_ends = time.time() + self.read_len
                    await self.broadcast(self.question_msg())
                    await asyncio.sleep(self.read_len)

                self.state = "question"
                self.q_start = time.time()          # the clock that scoring uses
                self.q_ends = self.q_start + self.answer_len
                await self.broadcast(self.question_msg())
                try:
                    await asyncio.wait_for(self.all_answered.wait(), timeout=self.answer_len)
                except asyncio.TimeoutError:
                    pass
                await self._reveal(i, q)
                await self._await_host()

            self.state = "ended"
            self.ended_at = time.time()
            ranking = rank_players(self.players.values())
            self.final_msg = {
                "type": "game_over",
                "leaderboard": self.board(ranking),
                "total_players": len(self.players),
            }
            await self.broadcast(self.final_msg)
        except asyncio.CancelledError:
            pass

    async def _await_host(self):
        """Hold on the insights screen until the host asks for the next question."""
        self.advance.clear()
        try:
            await asyncio.wait_for(self.advance.wait(), timeout=self.advance_timeout)
        except asyncio.TimeoutError:
            logging.getLogger("quiz").info(
                "room %s advanced itself after %ss — no host input", self.code, self.advance_timeout)

    def request_next(self):
        """Host pressed Next. Ignored unless we are actually showing results."""
        if self.state == "results":
            self.advance.set()
            return True
        return False

    async def _reveal(self, i, q):
        self.state = "results"
        tally = [0] * len(q["options"])
        for email, p in self.players.items():
            resp = self.responses.get(email)
            if resp is None:
                p.answers.append({"option": None, "time": None,
                                  "correct": False, "points": 0})
                continue
            opt, t = resp
            if isinstance(opt, int) and 0 <= opt < len(tally):
                tally[opt] += 1
            correct = (opt == q["correct"])
            pts = score_answer(correct, t, self.answer_len)
            p.score += pts
            p.total_time += t
            p.answers.append({"option": opt, "time": round(t, 2),
                              "correct": correct, "points": pts})

        ranking = rank_players(self.players.values())
        rank_of = {p.email: n + 1 for n, p in enumerate(ranking)}
        self.last_ranks = rank_of
        base = {"type": "results", "index": i, "tally": tally,
                "correct": q["correct"], "options": q["options"],
                "code": q.get("code"), "image": q.get("image"),
                "leaderboard": self.board(ranking),   # deltas vs previous question
                "total_players": len(self.players),
                "last": i == len(self.questions) - 1}
        self.last_results = base   # replayed to anyone who reconnects into this screen
        self.prev_rank = rank_of   # must come after board(), which reads the old ranks
        await self._fan_out([
            (p, {**base, "your_score": p.score, "your_rank": rank_of[p.email],
                 "gained": p.answers[-1]["points"]})
            for p in list(self.players.values()) if p.ws
        ])
        await self.send_hosts(base)


class RoomManager:
    def __init__(self, settings, on_end=None):
        self.settings = settings
        self.rooms: dict[str, Room] = {}
        self.on_end = on_end   # called with the room once its game finishes

    def _code(self):
        ab = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        while True:
            c = "".join(secrets.choice(ab) for _ in range(6))
            if c not in self.rooms:
                return c

    def create(self, capacity, questions, title=""):
        code = self._code()
        self.rooms[code] = Room(code, capacity, questions,
                                self.settings.advance_timeout_secs, title,
                                self.settings.read_secs)
        return code

    def get(self, code):
        return self.rooms.get(code)

    def start(self, room):
        if room.started or room.state != "lobby":
            return False
        room.started = True
        room.task = asyncio.create_task(self._run(room))
        return True

    async def _run(self, room):
        await room.run()
        if self.on_end and room.state == "ended":
            try:
                self.on_end(room)
            except Exception:          # history is nice-to-have, never break the game
                logging.getLogger("quiz").exception("failed to archive room %s", room.code)

    def reap(self):
        now = time.time()
        ttl = self.settings.room_ttl_secs
        for code in list(self.rooms):
            r = self.rooms[code]
            if r.ended_at and now - r.ended_at > ttl:
                self.rooms.pop(code, None)
            elif not r.started and now - r.created > ttl:
                self.rooms.pop(code, None)

    def shutdown(self):
        for r in self.rooms.values():
            if r.task and not r.task.done():
                r.task.cancel()


def build_csv(room):
    buf = io.StringIO()
    w = csv.writer(buf)
    nq = len(room.questions)
    header = ["email", "score"]
    for i in range(nq):
        header += [f"q{i+1}_answer", f"q{i+1}_correct", f"q{i+1}_time"]
    w.writerow(header)
    for p in rank_players(room.players.values()):
        row = [p.email, p.score]
        for i in range(nq):
            a = p.answers[i] if i < len(p.answers) else None
            opt = a["option"] if a else None
            if a and isinstance(opt, int) and 0 <= opt < len(room.questions[i]["options"]):
                row += [room.questions[i]["options"][opt],
                        1 if a["correct"] else 0, a["time"]]
            else:
                row += ["", 0, ""]
        w.writerow(row)
    return buf.getvalue()
