"""A full classroom, for real: N websocket players run a whole quiz.

Not a synthetic benchmark — every player is a live socket that joins, waits out
the reading beat, answers, rides the between-question gate and reaches the
podium. It asserts on the things that decide whether a lecture goes well:

  * everybody gets in, inside a sane window
  * nobody's answer is silently dropped
  * the console's count matches reality
  * a burst of drops mid-question does not end it early or lose scores
  * the CSV at the end has one complete row per student

    docker compose exec app python /srv/test_load.py
    PLAYERS=50 QUESTIONS=3 python test_load.py
"""
import asyncio
import contextlib
import json
import os
import statistics
import sys
import time
import urllib.parse
import urllib.request

import websockets

BASE = os.getenv("BASE", "http://localhost:8000")
WS = BASE.replace("http", "ws")
USER = os.getenv("ADMIN_USER", "Admin")
PASS = os.getenv("ADMIN_PASS", "AUACAD@2026")
READ = int(os.getenv("READ_SECS", "5"))
PLAYERS = int(os.getenv("PLAYERS", "50"))
QUESTIONS = int(os.getenv("QUESTIONS", "3"))
ANSWER_SECS = int(os.getenv("ANSWER_SECS", "8"))


def api(path, body=None, token=None, method=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method or ("POST" if body is not None else "GET"),
        headers={"Content-Type": "application/json",
                 **({"Authorization": "Bearer " + token} if token else {})})
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def ms(v):
    return f"{v * 1000:.0f}ms"


class Student:
    """One phone. Keeps every frame it was sent so the run can be audited."""

    def __init__(self, i):
        self.i = i
        self.seat = f"s{i:03d}@class.edu"
        self.ws = None
        self.msgs = []
        self.answered = 0
        self.join_secs = None
        self.reply_secs = []
        self.reconnects = 0

    async def connect(self, code):
        """Read until our own `joined` lands.

        Not necessarily the first frame: the server sets player.ws before it
        sends `joined`, so during a 50-way join burst another student's lobby
        broadcast can reach this socket first. Harmless — the client handles the
        two in either order — but a test that assumes ordering will flake.
        """
        t0 = time.monotonic()
        self.ws = await websockets.connect(
            f"{WS}/ws/play/{code}?seat={urllib.parse.quote(self.seat)}",
            open_timeout=30, ping_interval=None)
        while True:
            m = json.loads(await asyncio.wait_for(self.ws.recv(), timeout=30))
            self.msgs.append(m)
            if m.get("type") == "joined":
                break
            assert m.get("type") != "error", f"student {self.i}: {m.get('msg')}"
        self.join_secs = time.monotonic() - t0

    async def pump(self, secs):
        end = time.monotonic() + secs
        while True:
            left = end - time.monotonic()
            if left <= 0:
                return
            try:
                self.msgs.append(json.loads(
                    await asyncio.wait_for(self.ws.recv(), timeout=left)))
            except asyncio.TimeoutError:
                return
            except Exception:
                return

    async def answer(self, option):
        await self.ws.send(json.dumps({"type": "answer", "option": option}))
        self.answered += 1

    async def await_kind(self, kind, timeout):
        """Wait for a frame of `kind`, recording when it landed. This is the
        number that matters: how far apart the room sees the same screen."""
        end = time.monotonic() + timeout
        while True:
            left = end - time.monotonic()
            if left <= 0:
                return None
            try:
                m = json.loads(await asyncio.wait_for(self.ws.recv(), timeout=left))
            except Exception:
                return None
            self.msgs.append(m)
            if m.get("type") == kind:
                self.reply_secs.append(time.monotonic())
                return m

    def got(self, kind):
        return [m for m in self.msgs if m.get("type") == kind]

    async def close(self):
        try:
            await self.ws.close()
        except Exception:
            pass


async def main():
    print(f"\n{PLAYERS} students, {QUESTIONS} questions, against {BASE}\n")
    token = api("/api/login", {"username": USER, "password": PASS})["token"]
    title = f"load-{PLAYERS}-{int(time.time())}"
    qs = [{"text": f"Question {i + 1}", "options": ["a", "b", "c", "d"],
           "correct": i % 4, "timer": READ + ANSWER_SECS} for i in range(QUESTIONS)]
    code = api("/api/quiz", {"title": title, "capacity": PLAYERS + 10,
                             "questions": qs, "mode": {}}, token)["room_code"]

    host = await websockets.connect(f"{WS}/ws/host/{code}?token={token}",
                                    ping_interval=None)
    students = [Student(i) for i in range(PLAYERS)]

    # ---- the join burst: a class opens the link within the same half-minute ----
    t0 = time.monotonic()
    await asyncio.gather(*(s.connect(code) for s in students))
    burst = time.monotonic() - t0
    joins = sorted(s.join_secs for s in students)
    assert all(s.got("joined") for s in students), "someone never got a `joined`"
    print(f"  join burst   {PLAYERS} sockets in {burst:.2f}s  "
          f"(median {ms(statistics.median(joins))}, slowest {ms(joins[-1])})")
    assert burst < 20, f"a class took {burst:.1f}s to get in"

    async def host_pump(secs):
        out, end = [], time.monotonic() + secs
        while True:
            left = end - time.monotonic()
            if left <= 0:
                return out
            try:
                out.append(json.loads(
                    await asyncio.wait_for(host.recv(), timeout=left)))
            except Exception:
                return out

    hm = await host_pump(2)
    lob = [m for m in hm if m.get("type") == "lobby"]
    assert lob and lob[-1]["count"] == PLAYERS, \
        f"console shows {lob[-1]['count'] if lob else '?'} of {PLAYERS}"
    print(f"  lobby        console agrees: {lob[-1]['count']} joined")

    await host.send(json.dumps({"type": "start"}))
    dropped_once = False
    all_reply = []

    for qi in range(QUESTIONS):
        if qi:
            # The between-question gate. Wait for the room to actually reach
            # `waiting` before pressing — the console's Start button only exists
            # on that screen, so pressing earlier is not a thing a host can do,
            # and the server rightly ignores it.
            waited = 0.0
            while waited < 10:
                frames = await host_pump(0.4)
                waited += 0.4
                if any(m.get("type") == "lobby" and m.get("state") == "waiting"
                       for m in frames):
                    break
            else:
                raise AssertionError(f"room never reached the gate before q{qi + 1}")
            await host.send(json.dumps({"type": "begin"}))
        # ride out the reading beat
        await asyncio.gather(host_pump(READ + 1.0),
                             *(s.pump(READ + 1.0) for s in students))
        for s in students:
            # index-specific: a stale frame from the previous question must not
            # be able to satisfy this
            asking = [m for m in s.got("question")
                      if m.get("phase") == "answering" and m.get("index") == qi]
            assert asking, f"student {s.i} never saw question {qi + 1}"
            assert asking[-1]["options"], "options missing at the reveal"

        # a third of the room drops mid-question on question 2 — classroom wifi
        casualties = []
        if qi == 1:
            casualties = students[: PLAYERS // 3]
            await asyncio.gather(*(s.close() for s in casualties))
            dropped_once = True

        t0 = time.monotonic()
        live = [s for s in students if s not in casualties]
        await asyncio.gather(*(s.answer((qi + s.i) % 4) for s in live))
        answer_burst = time.monotonic() - t0

        # the dropped third comes straight back and answers late
        if casualties:
            async def revive(s):
                await s.connect(code)
                s.reconnects += 1
                await s.answer((qi + s.i) % 4)
            await asyncio.gather(*(revive(s) for s in casualties))

        # every phone waits for the reveal; the spread between first and last
        # is the fan-out cost the room actually feels
        waiters = asyncio.gather(*(s.await_kind("results", ANSWER_SECS + 6)
                                   for s in students))
        hq = await host_pump(ANSWER_SECS + 4)
        await waiters
        seen = sorted(s.reply_secs[-1] for s in students if s.reply_secs)
        if len(seen) == PLAYERS:
            all_reply.append(seen[-1] - seen[0])
        prog = [m for m in hq if m.get("type") == "progress"]
        res = [m for m in hq if m.get("type") == "results"]
        if not res:
            print(f"    debug host frames q{qi + 1}: "
                  f"{[m.get('type') for m in hq]}")
            print(f"    debug room state: {api('/api/health')}")
            for s_ in students[:3]:
                print(f"    debug s{s_.i}: {[m.get('type') for m in s_.msgs[-6:]]}")
        assert res, f"question {qi + 1} never revealed"
        counted = sum(res[-1]["tally"])
        assert counted == PLAYERS, \
            f"q{qi + 1}: {counted} answers counted, {PLAYERS} were sent"
        print(f"  question {qi + 1}   {PLAYERS} answers in {answer_burst:.2f}s, "
              f"all {counted} counted"
              + (f", {len(casualties)} dropped+rejoined" if casualties else ""))
        if prog:
            assert prog[-1]["total"] == PLAYERS, \
                f"console denominator drifted to {prog[-1]['total']}"
        await host.send(json.dumps({"type": "next"}))

    hm = await host_pump(6)
    over = [m for m in hm if m.get("type") == "game_over"]
    assert over, "the room never finished"
    board = over[-1]["leaderboard"]
    assert over[-1]["total_players"] == PLAYERS, over[-1]["total_players"]
    print(f"  finale       ranked {over[-1]['total_players']} players, "
          f"top score {board[0]['score']}")

    if all_reply:
        print(f"  fan-out      results reached all {PLAYERS} phones within "
              f"{ms(max(all_reply))} of each other (worst question)")

    # ---- the CSV is the artefact that has to survive all of it ----
    req = urllib.request.Request(BASE + f"/api/room/{code}/csv",
                                 headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(req) as r:
        csv = r.read().decode()
    lines = csv.strip().splitlines()
    assert len(lines) == PLAYERS + 1, f"CSV has {len(lines) - 1} rows for {PLAYERS}"
    cols = len(lines[0].split(","))
    assert cols == 2 + 3 * QUESTIONS, cols
    blank = [l for l in lines[1:] if l.split(",")[1] == ""]
    assert not blank, f"{len(blank)} students have no score"
    print(f"  csv          {len(lines) - 1} rows x {cols} columns, every score present")

    assert dropped_once and sum(s.reconnects for s in students) == PLAYERS // 3
    print(f"\n{PLAYERS} students survived {QUESTIONS} questions with a mid-quiz "
          f"wifi drop. No answers lost.\n")
    # Bounded: closing a few hundred sockets can leave a straggler waiting on a
    # close handshake, and a suite that hangs after passing reads as a failure to
    # whoever runs it before a class.
    with contextlib.suppress(asyncio.TimeoutError):
        await asyncio.wait_for(
            asyncio.gather(*(s.close() for s in students), host.close(),
                           return_exceptions=True),
            timeout=10)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except AssertionError as e:
        print(f"\nFAILED: {e}\n")
        sys.exit(1)
    sys.exit(0)
