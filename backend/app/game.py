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


# ---------- per-quiz switches ----------
# Six independent switches. The FIRST value of each is what the app did before
# they existed, so an old sqlite row, a missing key or a hand-edited database all
# come back as the quiz that used to run.
MODES = {
    "identity": ("email", "name", "anonymous"),
    "grading":  ("graded", "feedback"),
    "scoring":  ("absolute", "relative", "flat", "none"),
    "reveal":   (True, False),
    "board":    ("always", "end", "never"),
    "timing":   ("countdown", "open"),
}

FLAT_POINTS = 1000    # `flat` scoring: same ceiling as the speed curves, so one CSV compares


def clean_mode(m):
    """Normalise the switches and settle what depends on what — once, here.

    Called from Room.__init__ rather than from the request model on purpose:
    /api/quizzes/{id}/run hands raw sqlite dicts to the engine and never runs
    pydantic, so this is the real trust boundary.

    The three dependency rules below are why the rest of the codebase needs
    almost no mode awareness. They make the degenerate states unreachable instead
    of leaving every screen to defend against them: no answer key means no
    scoring, no scoring means no leaderboard, and an open-ended question has no
    window to measure absolute speed against.
    """
    m = m or {}
    out = {k: (m.get(k) if m.get(k) in vals else vals[0]) for k, vals in MODES.items()}
    if out["grading"] == "feedback":
        out["scoring"] = "none"
    if out["scoring"] == "none":
        out["board"] = "never"
    if out["timing"] == "open" and out["scoring"] == "absolute":
        out["scoring"] = "relative"
    return out


# ---------- pure scoring (unit-tested) ----------
def score_answer(correct: bool, t: float, timer: float) -> int:
    """Kahoot-style: instant-correct ~1000, last-second-correct ~500, wrong 0."""
    if not correct:
        return 0
    t = max(0.0, min(t, timer))
    return round(1000 * (1 - t / timer) / 2 + 500)


def score_relative(correct: bool, t: float, first: float, close: float) -> int:
    """Speed measured against the room instead of against a clock.

    The window runs from the first answer in to the moment the host closed the
    question, so the quickest responder takes full marks and someone answering as
    it closes takes the floor. Needs no fixed duration, which is what makes it the
    only speed scoring an open-ended question can have. Same 1000..500 band as
    score_answer so the two are comparable in one export.
    """
    if not correct:
        return 0
    span = close - first
    if span <= 0:          # a lone responder, or a host who closed on the instant
        return 1000
    k = max(0.0, min(1.0, (t - first) / span))
    return round(1000 * (1 - k) / 2 + 500)


def dense_ranks(ranking):
    """email -> rank, for an already-sorted ranking. Equal scores share a rank
    and the next distinct score takes the next number, so a board reads 1, 1, 2
    with no gaps. Cumulative answer time still orders people *within* a tie, but
    no longer separates them: level scores finish level."""
    out, rank, last = {}, 0, object()
    for p in ranking:
        if p.score != last:
            rank += 1
            last = p.score
        out[p.email] = rank
    return out


def absent_answer():
    """Stand-in for a question a player was not in the room for. Scores nothing,
    like an unanswered one, but stays distinguishable so the CSV can leave the
    cell empty rather than claiming they got it wrong."""
    return {"option": None, "time": None, "correct": False, "points": 0, "absent": True}


def rank_players(players):
    """Score desc, then earliest cumulative answer time as tiebreak."""
    return sorted(players, key=lambda p: (-p.score, p.total_time))


ADJ = "Swift Brave Calm Bright Bold Quiet Sunny Clever Lucky Merry Nimble Keen".split()
ANIMAL = "Otter Falcon Panda Heron Fox Lynx Badger Cobra Ibis Moth Raven Yak".split()


def fun_name(taken):
    """A readable handle for someone who joined without giving one — something you
    can shout across a room. 144 pairs.

    ponytail: numbered fallback past roughly 60 in one room; widen the word lists
    if that ever turns up on a projector.
    """
    for _ in range(50):
        n = f"{secrets.choice(ADJ)} {secrets.choice(ANIMAL)}"
        if n.lower() not in taken:
            return n
    return f"Player {len(taken) + 1}"


class Player:
    # `email` is the seat key. In email mode it really is an address; otherwise it
    # is an opaque per-device id, and `name` is what every payload travels under.
    __slots__ = ("email", "name", "score", "total_time", "ws", "answers")

    def __init__(self, email, name=None):
        self.email = email
        self.name = name or email
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
    def __init__(self, code, capacity, questions, advance_timeout, title="", read_secs=0,
                 mode=None):
        self.code = code
        self.title = title
        self.capacity = capacity
        self.questions = questions
        self.read_secs = read_secs
        self.mode = clean_mode(mode)
        self.timed = self.mode["timing"] == "countdown"
        self.read_len = 0        # this question's reading phase
        self.answer_len = 0      # this question's answering phase — scoring uses this
        self.read_ends = 0.0
        # the host drives advancing; this is only a backstop so a host who walks
        # away cannot pin a room in memory forever
        self.advance_timeout = advance_timeout
        self.advance = asyncio.Event()
        self.players: dict[str, Player] = {}
        self.hosts = set()
        self.state = "lobby"          # lobby | reading | question | results | ended
        self.q_index = -1
        self.revealed = 0             # questions scored so far; pads a late joiner's answers
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
    def _display_name(self, seat, wanted):
        """Returns (name, error_msg). What this player is called on every screen.

        Unique per room in all three identity modes, because the name is also the
        identity every payload travels under — the seat key never leaves the
        server, so nobody can read a leaderboard and take over someone's seat.
        """
        kind = self.mode["identity"]
        if kind == "email":
            return seat, None
        taken = {p.name.lower() for p in self.players.values()}
        if kind == "anonymous":
            return fun_name(taken), None
        wanted = " ".join((wanted or "").split())[:24]
        if not wanted:
            return None, "Enter a name to join"
        if wanted.lower() in taken:
            return None, f"“{wanted}” is taken — try another"
        return wanted, None

    def add_or_reconnect(self, email, name=""):
        """Returns (player, error_msg). error_msg is None on success.

        A known seat always reconnects and keeps its score — that is what makes
        a browser refresh survivable. If a socket is still open on that player the
        caller takes it over and closes the old one; last device in wins.

        Outside email mode the seat is a per-device id rather than anything the
        player typed, which is what lets a name clash be rejected outright without
        locking someone out of their own score when they refresh.

        A new email may arrive at any point while the quiz is running and is put
        straight onto whatever screen the room is showing, current question
        included. They score from where they walked in: questions that were
        already asked are worth nothing to them, so the room keeps one set of
        rules and one comparable leaderboard.
        """
        existing = self.players.get(email)
        if existing is not None:
            return existing, None
        if self.state == "ended":
            return None, "This quiz has already finished"
        if len(self.players) >= self.capacity:
            return None, "Room is full"
        display, err = self._display_name(email, name)
        if err:
            return None, err
        p = Player(email, display)
        # answers is positional — build_csv reads answers[i] as question i — so
        # someone arriving at Q8 needs Q1..Q7 standing in the list already, or
        # every column of their row slides left onto the wrong question
        p.answers = [absent_answer() for _ in range(self.revealed)]
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
        # `opt` arrives straight off the wire. Reject anything that is not a real
        # option index here rather than downstream: an ungraded question has
        # correct=None, and a null answer would otherwise satisfy `opt == correct`
        # and score full marks.
        if not isinstance(opt, int) or isinstance(opt, bool) or not (
                0 <= opt < len(self.questions[self.q_index]["options"])):
            return
        t = max(0.0, time.time() - self.q_start)
        # an open question has no window to clamp against — it runs until the host
        # closes it, and relative scoring measures the spread rather than a ceiling
        self.responses[email] = (opt, min(t, self.answer_len) if self.timed else t)
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
        """Top-N leaderboard rows with rank movement since the previous question.
        Ranks are dense, so tied players carry the same number."""
        ranks = dense_ranks(ranking)
        rows = []
        for p in ranking[:limit]:
            prev = self.prev_rank.get(p.email)
            rank = ranks[p.email]
            # `name`, never the seat key — that key is a bearer credential for a
            # seat, and this payload goes to every phone in the room
            rows.append({"name": p.name, "score": p.score, "rank": rank,
                         "delta": 0 if prev is None else prev - rank})
        return rows

    def lobby_msg(self):
        return {"type": "lobby", "players": [p.name for p in self.players.values()],
                "count": len(self.players), "capacity": self.capacity,
                "state": self.state, "title": self.title}

    def question_msg(self):
        q = self.questions[self.q_index]
        reading = self.state == "reading"
        ends = self.read_ends if reading else self.q_ends
        msg = {"type": "question", "index": self.q_index,
               "total": len(self.questions), "text": q["text"],
               "phase": "reading" if reading else "answering",
               "code": q.get("code"), "image": q.get("image")}
        if reading or self.timed:
            # seconds left at send time, not an absolute stamp — the client
            # counts down locally so its clock never has to match ours
            msg["remaining"] = max(0.0, round(ends - time.time(), 2))
            msg["window"] = self.read_len if reading else self.answer_len
        else:
            # an open question has no deadline to count down to, so send how long
            # it has been up and let the client count forward. Still a delta, for
            # the same reason `remaining` is one.
            msg["elapsed"] = max(0.0, round(time.time() - self.q_start, 2))
        if not reading:
            msg["options"] = q["options"]        # withheld until the reveal
        return msg

    def results_msg_for(self, player):
        """Rebuild the results screen for someone who reconnected into it."""
        if not self.last_results:
            return None
        if self.mode["scoring"] == "none":
            return dict(self.last_results)     # nothing personal to add to a poll
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
                if self.timed:
                    try:
                        await asyncio.wait_for(self.all_answered.wait(),
                                               timeout=self.answer_len)
                    except asyncio.TimeoutError:
                        pass
                else:
                    # open question: no clock, and deliberately no auto-close when
                    # everyone has answered — the host decides when the discussion
                    # is done. Nothing awaits all_answered here, so setting it is
                    # a harmless no-op and needs no guard.
                    await self._await_host()
                await self._reveal(i, q)
                await self._await_host()

            self.state = "ended"
            self.ended_at = time.time()
            ranking = rank_players(self.players.values())
            self.final_msg = {
                "type": "game_over",
                "total_players": len(self.players),
            }
            if self.mode["board"] != "never":     # `end` shows it only here
                self.final_msg["leaderboard"] = self.board(ranking)
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
        """Host pressed Next, or Finish on an open question.

        Still ignored during a question that is on a clock, so a stray click can
        never cut one short.
        """
        if self.state == "results" or (self.state == "question" and not self.timed):
            self.advance.set()
            return True
        return False

    def _scorer(self):
        """This question's scoring function.

        Built here, in _reveal, because self.responses is complete and frozen by
        now — which is what lets `relative` see the whole room's timings before a
        single point is awarded, with no extra bookkeeping during the question.
        """
        s = self.mode["scoring"]
        if s == "none":
            return lambda ok, t: 0
        if s == "flat":
            return lambda ok, t: FLAT_POINTS if ok else 0
        if s == "relative":
            times = [t for _, t in self.responses.values()]
            first = min(times) if times else 0.0
            # the question closed now: the host's Finish press, or the clock running out
            close = max(time.time() - self.q_start, first)
            return lambda ok, t: score_relative(ok, t, first, close)
        return lambda ok, t: score_answer(ok, t, self.answer_len)

    async def _reveal(self, i, q):
        self.state = "results"
        # the mode has the final say: a quiz flipped to `feedback` still carries
        # the answer indexes it was built with, and reading gradedness off the
        # question alone would ship that key to every phone in a room that was
        # told it has no right answer
        graded = self.mode["grading"] == "graded" and q.get("correct") is not None
        score = self._scorer()
        tally = [0] * len(q["options"])
        for email, p in self.players.items():
            resp = self.responses.get(email)
            if resp is None:
                p.answers.append({"option": None, "time": None,
                                  "correct": False, "points": 0})
                continue
            opt, t = resp
            tally[opt] += 1          # record_answer already proved this is in range
            correct = graded and opt == q["correct"]
            pts = score(correct, t)
            p.score += pts
            p.total_time += t
            p.answers.append({"option": opt, "time": round(t, 2),
                              "correct": correct, "points": pts})

        self.revealed = i + 1          # anyone joining from here on pads to this
        ranking = rank_players(self.players.values())
        rank_of = dense_ranks(ranking)   # tied scores share a rank, so do their deltas
        self.last_ranks = rank_of
        base = {"type": "results", "index": i, "tally": tally,
                "options": q["options"],
                "code": q.get("code"), "image": q.get("image"),
                "total_players": len(self.players),
                "last": i == len(self.questions) - 1}
        # everything below is omitted rather than nulled when it does not apply —
        # the clients draw what they are given, and know nothing about the mode
        if graded and self.mode["reveal"]:
            base["correct"] = q["correct"]
        if self.mode["board"] == "always":
            base["leaderboard"] = self.board(ranking)   # deltas vs previous question
        self.last_results = base   # replayed to anyone who reconnects into this screen
        self.prev_rank = rank_of   # must come after board(), which reads the old ranks
        scored = self.mode["scoring"] != "none"
        await self._fan_out([
            (p, {**base, **({"your_score": p.score, "your_rank": rank_of[p.email],
                             "gained": p.answers[-1]["points"]} if scored else {})})
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

    def create(self, capacity, questions, title="", mode=None):
        code = self._code()
        self.rooms[code] = Room(code, capacity, questions,
                                self.settings.advance_timeout_secs, title,
                                self.settings.read_secs, mode)
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
    # "name" is the email itself in email mode, so this column is unchanged there
    header = ["name", "score"]
    for i in range(nq):
        header += [f"q{i+1}_answer", f"q{i+1}_correct", f"q{i+1}_time"]
    w.writerow(header)
    for p in rank_players(room.players.values()):
        row = [p.name, p.score]
        for i in range(nq):
            a = p.answers[i] if i < len(p.answers) else None
            opt = a["option"] if a else None
            if a and isinstance(opt, int) and 0 <= opt < len(room.questions[i]["options"]):
                row += [room.questions[i]["options"][opt],
                        1 if a["correct"] else 0, a["time"]]
            elif a and a.get("absent"):
                row += ["", "", ""]      # had not joined yet — not the same as a blank
            else:
                row += ["", 0, ""]       # in the room, did not answer
        w.writerow(row)
    return buf.getvalue()
