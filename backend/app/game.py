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
import statistics
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
    "grading":  ("graded", "feedback", "livepoll", "average"),
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
    if out["grading"] != "graded":
        out["scoring"] = "none"
    if out["grading"] in ("livepoll", "average"):
        # the columns fill as the room answers and the host closes it when the
        # answers stop coming — a countdown would cut the discussion off
        out["timing"] = "open"
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


def picks_of(opt):
    """An answer (or an answer key) as a list of option indexes: one for a
    single-answer question, any number for a select-all one, none for no answer."""
    if opt is None:
        return []
    return list(opt) if isinstance(opt, (list, tuple)) else [opt]


def answer_key(q):
    """The correct options as a set, or None when the question has no key."""
    key = set(picks_of(q.get("correct")))
    return key or None


def is_right(q, opt):
    """All-or-nothing: a select-all question is right only when exactly the
    correct set was picked. One missed or one extra is wrong."""
    key = answer_key(q)
    return key is not None and set(picks_of(opt)) == key


def tally_of(responses, n_options):
    """Picks per option. On a select-all question one person adds to several
    options, so these can sum past the number who answered. record_answer has
    already proved every index is in range."""
    counts = [0] * n_options
    for opt, _ in responses.values():
        for j in picks_of(opt):
            counts[j] += 1
    return counts


def spread_of(responses):
    """A live-average question's numbers: how many answered, the mean, and the
    median, which is what to look at when a few extreme answers drag the mean."""
    vals = [v for v, _ in responses.values()]
    if not vals:
        return {"count": 0, "average": None, "median": None}
    return {"count": len(vals), "average": round(statistics.fmean(vals), 2),
            "median": statistics.median(vals)}


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
        # every question takes a whole number in [min, max] instead of an option
        self.numeric = self.mode["grading"] == "average"
        self.read_len = 0        # this question's reading phase
        self.answer_len = 0      # this question's answering phase — scoring uses this
        self.read_ends = 0.0
        # the host drives advancing; this is only a backstop so a host who walks
        # away cannot pin a room in memory forever
        self.advance_timeout = advance_timeout
        self.advance = asyncio.Event()
        # a separate event from `advance` on purpose: sharing one would let a
        # double-tap on "Next question" fall straight through the waiting room
        self.begin = asyncio.Event()
        self.players: dict[str, Player] = {}
        self.hosts = set()
        self.state = "lobby"          # lobby | reading | question | results | ended
        self.q_index = -1
        self.revealed = 0             # questions scored so far; pads a late joiner's answers
        self.q_start = 0.0
        self.q_ends = 0.0
        self.responses: dict[str, tuple] = {}
        # select-all ticks not yet submitted; they count anyway if the question
        # closes first (see _submit_drafts)
        self.drafts: dict[str, list] = {}
        self.all_answered = asyncio.Event()
        self.started = False
        self.task = None
        self.created = time.time()
        self.ended_at = None
        self.prev_rank: dict[str, int] = {}   # email -> rank after the previous question
        # the room sees the standings when the host reveals them, not the instant
        # they are computed — reset per question in run()
        self.board_shown = False
        # snapshots so a reconnecting client can be put back on the right screen
        self.last_results = None
        self.last_board = None       # the `board` payload, withheld until shown
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
    def _clean_answer(self, opt, allow_empty=False):
        """`opt` arrives straight off the wire. Returns it as this question
        stores it (an index, or a sorted list of them on a select-all question)
        or None when it is not a real answer. Rejected here rather than
        downstream: an ungraded question has correct=None, and a null answer
        must never be able to match it and score."""
        q = self.questions[self.q_index]
        if self.numeric:
            # a live average takes one whole number inside the question's range
            ok_num = isinstance(opt, int) and not isinstance(opt, bool)
            return opt if ok_num and q["min"] <= opt <= q["max"] else None
        n = len(q["options"])

        def ok(i):
            return isinstance(i, int) and not isinstance(i, bool) and 0 <= i < n
        if not q.get("multi"):
            return opt if ok(opt) else None
        if not isinstance(opt, list) or not all(ok(i) for i in opt):
            return None
        opt = sorted(set(opt))
        return opt if opt or allow_empty else None

    def record_pick(self, email, opt):
        """A tick or untick on a select-all question, before Submit. Held as a
        draft so a question closing on someone who ticked but never pressed
        Submit still counts what they ticked."""
        if self.state != "question" or email in self.responses or email not in self.players:
            return
        if not self.questions[self.q_index].get("multi"):
            return
        opt = self._clean_answer(opt, allow_empty=True)
        if opt is None:
            return
        if opt:
            self.drafts[email] = opt
        else:
            self.drafts.pop(email, None)

    def _submit_drafts(self):
        """The question just closed: whatever was ticked and never submitted
        goes in as the slowest possible answer, at the end of the clock or at the
        host's close on an open question."""
        late = self.answer_len if self.timed else max(0.0, time.time() - self.q_start)
        for email, opt in self.drafts.items():
            if email not in self.responses and email in self.players:
                self.responses[email] = (opt, late)
        self.drafts = {}

    def record_answer(self, email, opt):
        if self.state != "question" or email in self.responses:
            return
        p = self.players.get(email)
        if p is None:
            return
        opt = self._clean_answer(opt)
        if opt is None:
            return
        self.drafts.pop(email, None)
        t = max(0.0, time.time() - self.q_start)
        # an open question has no window to clamp against — it runs until the host
        # closes it, and relative scoring measures the spread rather than a ceiling
        self.responses[email] = (opt, min(t, self.answer_len) if self.timed else t)
        self.check_all_answered()
        return True

    def check_all_answered(self):
        """Close the question early only when EVERY player in the room answered.

        It used to excuse whoever was disconnected, which is the same trap the
        play handler already refuses to fall into on the disconnect side: on
        classroom wifi a burst of drops shrinks "connected" to the handful who
        already answered, and the next answer slams the question shut on
        everyone still reconnecting — they come back to a question that is over
        and score nothing. With 50 phones that is not an edge case, it is
        Tuesday.

        Counting the whole room instead means one dead phone makes the rest wait
        out the clock. That wait is bounded by the answer window and the console
        shows "49 of 50 answered" the whole time, which is a far better failure
        than silently eating a third of the room's answers.
        """
        if self.state != "question" or not self.players:
            return
        if all(p.email in self.responses for p in self.players.values()):
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

    def question_msg(self, host=False):
        """`host=True` adds the console's numbers. They are withheld from phones
        on purpose: the live tally would let a late answerer follow the crowd,
        which is the one thing a poll must not allow. A phone gets the question,
        the options and its own answer — nothing about the rest of the room."""
        q = self.questions[self.q_index]
        reading = self.state == "reading"
        ends = self.read_ends if reading else self.q_ends
        msg = {"type": "question", "index": self.q_index,
               "total": len(self.questions), "text": q["text"],
               "phase": "reading" if reading else "answering",
               "code": q.get("code"), "image": q.get("image")}
        if q.get("multi"):
            msg["multi"] = True     # "Select all that apply": ticks and a Submit
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
            if self.numeric:
                msg["range"] = [q["min"], q["max"]]
            else:
                msg["options"] = q["options"]    # withheld until the reveal
        if host and not reading:
            # so the console opens on "0 of 24 answered" rather than "0 of 0" and
            # never has to wait for the first answer to learn the room size
            msg["answered"] = len(self.responses)
            msg["players"] = len(self.players)
            if self.mode["grading"] == "livepoll":
                msg["tally"] = tally_of(self.responses, len(q["options"]))
            if self.numeric:
                msg["spread"] = spread_of(self.responses)
        return msg

    async def broadcast_question(self):
        """One question, two payloads — the console's carries the room's numbers,
        the phones' carries only what the player is allowed to know."""
        await self._fan_out([(p, self.question_msg())
                             for p in list(self.players.values()) if p.ws])
        await self.send_hosts(self.question_msg(host=True))

    def progress_msg(self):
        """Host-only. `players` rather than the connected count: phones sleep and
        drop mid-question, and a total that slides downward reads as broken."""
        msg = {"type": "progress", "answered": len(self.responses),
               "total": len(self.players)}
        if self.mode["grading"] == "livepoll" and 0 <= self.q_index < len(self.questions):
            # the live columns. Hosts only — this never reaches a phone
            msg["tally"] = tally_of(self.responses,
                                    len(self.questions[self.q_index]["options"]))
        if self.numeric:
            # the running average, hosts only, for the same reason as the tally:
            # a phone that can see it answers the crowd instead of the question
            msg["spread"] = spread_of(self.responses)
        return msg

    def board_msg_for(self, player):
        """The standings, once the host has called for them."""
        if not self.last_board:
            return None
        return {**self.last_board, "your_rank": self.last_ranks.get(player.email, 0)}

    def show_board(self):
        """Host pressed "Show leaderboard". Returns False when there is nothing
        to show, so a stray click on a poll cannot fake a payload."""
        if self.state != "results" or not self.last_board:
            return False
        self.board_shown = True
        return True

    def results_msg_for(self, player):
        """Rebuild the results screen for someone who reconnected into it."""
        if not self.last_results:
            return None
        if self.mode["scoring"] == "none":
            return dict(self.last_results)     # nothing personal to add to a poll
        gained = player.answers[-1]["points"] if player.answers else 0
        # last_results is the PLAYER view: personal numbers only. The standings
        # live in last_board and go out separately, when the host asks for them.
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
            elif player.email in self.drafts:
                msg = {**msg, "your_picks": self.drafts[player.email]}
            return msg
        if self.state == "results":
            # mid-leaderboard, a refresh must come back to the leaderboard rather
            # than dropping a beat to the results bars. The live push is a lean
            # `board` that the client merges into what it already has; a resume
            # has nothing to merge into, so it carries the whole screen.
            if self.board_shown:
                return {**(self.results_msg_for(player) or {}),
                        **self.board_msg_for(player)}
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
        # Capture the socket each send actually goes to. The cleanup below runs
        # after an await, and a phone that dropped and came straight back has a
        # NEW socket on the player by then. Re-reading p.ws there would clear the
        # fresh socket and hang up the reconnect that just succeeded — on
        # classroom wifi, drop-and-rejoin during a broadcast is the normal case,
        # so that kicked students out for as long as the room kept broadcasting.
        sending = [(p, p.ws) for p, _ in targets]
        oks = await asyncio.gather(
            *(self._send(ws, m) for (_, ws), (_, m) in zip(sending, targets)),
            return_exceptions=True)
        for (p, ws), ok in zip(sending, oks):
            # only if this is still the live socket — same guard the play handler
            # uses when it unregisters, and for the same reason
            if ok is not True and ws is not None and p.ws is ws:
                # Forgetting the socket is not enough: the phone gets no close
                # event, so it never reconnects and sits frozen on a stale
                # question while the class moves on. Hang up properly and let
                # its client come back and resume.
                p.ws = None
                asyncio.create_task(_hang_up(ws))

    async def broadcast(self, msg):
        await self._fan_out([(p, msg) for p in list(self.players.values()) if p.ws])
        await self.send_hosts(msg)

    async def send_hosts(self, msg):
        for hw in list(self.hosts):
            if not await self._send(hw, msg):
                # Hang up, don't just forget it. Discarding alone left the console
                # connected and still answered its pings, so it never reconnected
                # and never heard another message: Next went through but the
                # screen sat there until a refresh. Closed, it reconnects in a
                # second and ws_host puts it back on the current screen.
                self.hosts.discard(hw)
                asyncio.create_task(_hang_up(hw))

    # ---------- game loop ----------
    async def run(self):
        try:
            for i, q in enumerate(self.questions):
                self.q_index = i
                self.responses = {}
                self.drafts = {}
                self.board_shown = False
                self.all_answered = asyncio.Event()
                self.read_len, self.answer_len = split_timer(q["timer"], self.read_secs)

                # Every question opens the way the quiz did: the room back on the
                # join screen, latecomers scanning in, and nothing moving until
                # the host says everyone is ready. Skipped for the first question
                # — the opening lobby already is that gate.
                if i:
                    # cleared BEFORE the state goes live: request_begin() only
                    # fires while state is "waiting", so nothing valid is lost,
                    # and a press landing during the broadcast still counts
                    self.begin.clear()
                    self.state = "waiting"
                    await self.broadcast(self.lobby_msg())
                    await self._await_begin()

                if self.read_len:
                    # question alone first — no options sent, so they cannot be
                    # read out of the payload before everyone can see them
                    self.state = "reading"
                    self.read_ends = time.time() + self.read_len
                    await self.broadcast_question()
                    await asyncio.sleep(self.read_len)

                # an open question is closed by `next`; arm that gate before the
                # state that accepts it becomes visible
                self.advance.clear()
                self.state = "question"
                self.q_start = time.time()          # the clock that scoring uses
                self.q_ends = self.q_start + self.answer_len
                await self.broadcast_question()
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
                self.advance.clear()   # arm the results gate before _reveal opens it
                self._submit_drafts()  # no await between this and _reveal's state flip
                await self._reveal(i, q)
                await self._await_host()

            await self.finish()
        except asyncio.CancelledError:
            pass   # server shutdown, or the host ending it early (RoomManager.quit)

    async def finish(self, quit=False):
        """Close the room and send everyone the final screen. `quit` marks a quiz
        the host ended early, with `asked` saying how many questions counted."""
        self.state = "ended"
        self.ended_at = time.time()
        ranking = rank_players(self.players.values())
        self.final_msg = {
            "type": "game_over",
            "total_players": len(self.players),
        }
        if quit:
            self.final_msg.update(quit=True, asked=self.revealed)
        # `end` shows it only here; nothing revealed means nothing to rank
        if self.mode["board"] != "never" and self.revealed:
            self.final_msg["leaderboard"] = self.board(ranking)
        await self.broadcast(self.final_msg)

    async def _await_host(self):
        """Hold on the insights screen until the host asks for the next question.

        Deliberately does NOT clear the event. Clearing here loses a press that
        arrived while the state was already accepting one — and with a full class
        the fan-out before this call takes long enough to make that likely. Each
        gate clears its own event *before* opening, in run().
        """
        try:
            await asyncio.wait_for(self.advance.wait(), timeout=self.advance_timeout)
        except asyncio.TimeoutError:
            logging.getLogger("quiz").info(
                "room %s advanced itself after %ss — no host input", self.code, self.advance_timeout)

    async def _await_begin(self):
        """Hold on the between-questions lobby until the host starts it.

        Does not clear, for the same reason as _await_host: run() clears before
        opening the gate, so a press cannot be swallowed in between.
        """
        try:
            await asyncio.wait_for(self.begin.wait(), timeout=self.advance_timeout)
        except asyncio.TimeoutError:
            logging.getLogger("quiz").info(
                "room %s started itself after %ss — no host input",
                self.code, self.advance_timeout)

    def request_begin(self):
        """Host pressed "Start question N" on the waiting screen."""
        if self.state == "waiting":
            self.begin.set()
            return True
        return False

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
        graded = self.mode["grading"] == "graded" and answer_key(q) is not None
        score = self._scorer()
        tally = [] if self.numeric else tally_of(self.responses, len(q["options"]))
        for email, p in self.players.items():
            resp = self.responses.get(email)
            if resp is None:
                p.answers.append({"option": None, "time": None,
                                  "correct": False, "points": 0})
                continue
            opt, t = resp
            correct = graded and is_right(q, opt)
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
                "answered": len(self.responses),
                **({"multi": True} if q.get("multi") else {}),
                "options": q["options"],
                "code": q.get("code"), "image": q.get("image"),
                "total_players": len(self.players),
                "last": i == len(self.questions) - 1}
        # everything below is omitted rather than nulled when it does not apply —
        # the clients draw what they are given, and know nothing about the mode
        if graded and self.mode["reveal"]:
            base["correct"] = q["correct"]
            # people fully right. On a select-all question that is not any one
            # option's count, so the console cannot work it out from the tally
            base["got_it"] = sum(1 for o, _ in self.responses.values() if is_right(q, o))
        if self.mode["grading"] == "livepoll":
            # so a console that reconnects into this screen still draws the poll
            # columns rather than falling back to the graded bars
            base["poll"] = True
        if self.numeric:
            # once it is closed the number can no longer sway anyone, so the
            # phones get it too
            base["spread"] = spread_of(self.responses)
            base["range"] = [q["min"], q["max"]]

        # The standings are the host's to reveal. Sending them with the results
        # put the whole leaderboard on every phone while the host was still on
        # the bars, so the room had read the outcome before the projector showed
        # it. The host payload carries them; the player payload does not, and
        # show_board() releases them on the host's word.
        self.last_results = base                     # player view, no standings
        self.last_board = None
        host_msg = base
        if self.mode["board"] == "always":
            board = self.board(ranking)              # deltas vs previous question
            host_msg = {**base, "leaderboard": board}
            self.last_board = {"type": "board", "index": i, "leaderboard": board,
                               "total_players": len(self.players),
                               "last": base["last"]}
        before = self.prev_rank
        self.prev_rank = rank_of   # must come after board(), which reads the old ranks
        scored = self.mode["scoring"] != "none"
        await self._fan_out([
            (p, {**base, **({"your_score": p.score, "your_rank": rank_of[p.email],
                             "gained": p.answers[-1]["points"],
                             # places climbed since the last question; 0 on the first
                             # one, or for someone who just walked in
                             "your_move": before[p.email] - rank_of[p.email]
                             if p.email in before else 0} if scored else {})})
            for p in list(self.players.values()) if p.ws
        ])
        await self.send_hosts(host_msg)

    async def send_board(self):
        """Release the standings to the room. Returns False when there are none."""
        if not self.show_board():
            return False
        await self._fan_out([(p, self.board_msg_for(p))
                             for p in list(self.players.values()) if p.ws])
        return True


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
        if room.state == "ended":
            self._archive(room)

    def _archive(self, room):
        if not self.on_end:
            return
        try:
            self.on_end(room)
        except Exception:          # history is nice-to-have, never break the game
            logging.getLogger("quiz").exception("failed to archive room %s", room.code)

    async def quit(self, room):
        """The host ended the quiz early, from any screen. Every question already
        revealed stands; one still in flight is dropped unscored, since half a
        room's answers would score unfairly. Returns False if it had already ended."""
        if room.state == "ended":
            return False
        task = room.task
        # run() swallows the cancel and returns without finishing. Cancel until it
        # lands: on Python < 3.12 wait_for() can eat a cancel that arrives as the
        # thing it waits on completes (the last answer coming in, say), and the
        # loop would carry on into the next gate.
        while task and not task.done():
            task.cancel()
            await asyncio.wait({task}, timeout=0.5)
        if room.state == "ended":      # it reached the end on its own meanwhile
            return False
        # the report and CSV describe what was actually asked, not the whole plan
        room.questions = room.questions[:room.revealed]
        await room.finish(quit=True)
        if room.revealed:              # a room that never got going leaves no history
            self._archive(room)
        logging.getLogger("quiz").info("room %s ended by the host after %d question(s)",
                                       room.code, room.revealed)
        return True

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
            opts = room.questions[i]["options"]
            picks = picks_of(a["option"]) if a else []
            if a and room.numeric and isinstance(a["option"], int):
                row += [a["option"], "", a["time"]]   # the number they gave; nothing to grade
            elif picks and all(isinstance(j, int) and 0 <= j < len(opts) for j in picks):
                row += [" + ".join(opts[j] for j in picks),
                        1 if a["correct"] else 0, a["time"]]
            elif a and a.get("absent"):
                row += ["", "", ""]      # had not joined yet — not the same as a blank
            else:
                row += ["", 0, ""]       # in the room, did not answer
        w.writerow(row)
    return buf.getvalue()
