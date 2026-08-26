"""End-to-end checks for the failure modes that broke the 70-student pilot.

Runs against a live server (default http://localhost:8000). Each check asserts on
behaviour a flaky classroom network actually produces: dropped sockets, silent
half-open connections, and answers sent while the link is down.

    docker compose exec app python /app/test_resilience.py
"""
import asyncio
import json
import os
import sys
import time
import urllib.request

import websockets

BASE = os.getenv("BASE", "http://localhost:8000")
WS = BASE.replace("http", "ws")
USER = os.getenv("ADMIN_USER", "Admin")
PASS = os.getenv("ADMIN_PASS", "AUACAD@2026")

READ, ANSWER = 5, 7          # the room splits a 12s timer into 5s read + 7s answer


def post(path, body, token=None):
    req = urllib.request.Request(
        BASE + path, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json",
                 **({"Authorization": "Bearer " + token} if token else {})})
    return json.load(urllib.request.urlopen(req))


def get(path, token):
    req = urllib.request.Request(
        BASE + path, headers={"Authorization": "Bearer " + token})
    return json.load(urllib.request.urlopen(req))


def delete(path, token):
    req = urllib.request.Request(
        BASE + path, method="DELETE", headers={"Authorization": "Bearer " + token})
    return json.load(urllib.request.urlopen(req))


def new_room(token, n_players=10, mode=None):
    return post("/api/quiz", {
        "title": "Resilience", "capacity": n_players, "mode": mode or {},
        "questions": [{"text": "2+2?", "options": ["3", "4"], "correct": 1, "timer": READ + ANSWER}],
    }, token)["room_code"]


async def recv_until(ws, want, timeout=25):
    """Next message of a given type, skipping the chatter in between."""
    end = time.time() + timeout
    while time.time() < end:
        m = json.loads(await asyncio.wait_for(ws.recv(), timeout=end - time.time()))
        if m["type"] == want:
            return m
    raise AssertionError(f"never saw {want!r}")


async def join(code, email):
    ws = await websockets.connect(f"{WS}/ws/play/{code}?seat={email}")
    await recv_until(ws, "joined")
    return ws


# ---------------------------------------------------------------- checks
def check_gzip():
    """The bundle must compress. Uncompressed it is ~290KB a head, and 70 heads
    landing at once is what saturated the tunnel."""
    idx = urllib.request.urlopen(BASE + "/").read().decode()
    asset = idx.split('src="')[1].split('"')[0]
    req = urllib.request.Request(BASE + asset, headers={"Accept-Encoding": "gzip"})
    r = urllib.request.urlopen(req)
    assert r.headers.get("Content-Encoding") == "gzip", "JS bundle served uncompressed"
    size = int(r.headers.get("Content-Length") or len(r.read()))
    assert size < 120_000, f"gzipped bundle still {size}B"
    print(f"  ok  bundle gzipped -> {size // 1024}KB")


async def check_pong(code):
    """A heartbeat must be answered, on both socket types — an unanswered ping
    makes the client hang up on a perfectly good connection every 10s."""
    ws = await join(code, "ping@a.edu")
    await ws.send('{"type":"ping"}')
    await recv_until(ws, "pong", timeout=5)
    await ws.close()
    print("  ok  player ping -> pong")


async def check_host_pong(code, token):
    ws = await websockets.connect(f"{WS}/ws/host/{code}?token={token}")
    await ws.send('{"type":"ping"}')
    await recv_until(ws, "pong", timeout=5)
    await ws.close()
    print("  ok  host ping -> pong")


async def check_join_mid_question(token):
    """Someone walking in while a question is live is dropped straight into it,
    on the room's clock — not handed a private fresh window, and not made to
    wait outside until the next one."""
    code = new_room(token)
    early = await join(code, "early@a.edu")
    host = await websockets.connect(f"{WS}/ws/host/{code}?token={token}")
    await host.send('{"type":"start"}')

    while True:
        m = await recv_until(early, "question")
        if m["phase"] == "answering":
            break

    late = await join(code, "late@a.edu")          # arrives mid-question
    now = await recv_until(late, "question", timeout=5)
    assert now["phase"] == "answering", f"late joiner landed on {now['phase']}, not the question"
    assert now.get("options"), "late joiner got the question but no options"
    assert now["remaining"] < m["window"], "late joiner was given a fresh window"

    await late.send('{"type":"answer","option":1}')
    await early.send('{"type":"answer","option":1}')
    res = await recv_until(late, "results", timeout=ANSWER + 6)
    assert res["your_score"] > 0, "the late joiner's answer did not score"
    print(f"  ok  joined mid-question, scored {res['your_score']} on the room's clock")

    for ws in (early, late, host):
        await ws.close()


async def check_open_question_waits_for_the_host(token):
    """An open question has no clock AND no auto-finish: it must not close when
    the room has answered, only when the host says so.

    This is the one thing unit tests cannot reach — the second await point lives
    inside run()'s loop.
    """
    code = new_room(token, mode={"timing": "open"})
    a = await join(code, "open@a.edu")
    host = await websockets.connect(f"{WS}/ws/host/{code}?token={token}")
    await host.send('{"type":"start"}')

    while True:
        m = await recv_until(a, "question")
        if m["phase"] == "answering":
            break
    assert "remaining" not in m and "window" not in m, "an open question sent a countdown"
    assert m["elapsed"] >= 0, "an open question must report how long it has been up"

    await a.send('{"type":"answer","option":1}')      # the whole room has now answered
    try:
        await recv_until(a, "results", timeout=ANSWER + 3)
        raise AssertionError("the question closed on its own — it must wait for the host")
    except asyncio.TimeoutError:
        pass

    await host.send('{"type":"next"}')                # Finish question
    res = await recv_until(a, "results", timeout=5)
    assert res["your_score"] > 0, "answering first in an open question must score"
    print(f"  ok  open question held {ANSWER + 3}s, closed on the host ({res['your_score']} pts)")

    for ws in (a, host):
        await ws.close()


async def check_anonymous_needs_no_typing(token):
    """No name typed, and a refresh comes back as the same person."""
    code = new_room(token, mode={"identity": "anonymous"})
    ws = await websockets.connect(f"{WS}/ws/play/{code}?seat=device-aaa")
    first = await recv_until(ws, "joined")
    assert first["name"] and "@" not in first["name"], f"got {first.get('name')!r}"
    assert "email" not in first, "the seat key must never travel back to the client"
    await ws.close()

    again = await websockets.connect(f"{WS}/ws/play/{code}?seat=device-aaa")
    back = await recv_until(again, "joined")
    assert back["name"] == first["name"], "a refresh must come back as the same player"

    other = await websockets.connect(f"{WS}/ws/play/{code}?seat=device-bbb")
    two = await recv_until(other, "joined")
    assert two["name"] != first["name"], "two devices must not share a name"
    print(f"  ok  anonymous join -> {first['name']!r}, stable across a refresh")
    for w in (again, other):
        await w.close()


async def check_clock_is_universal(token):
    """One clock for the whole room, and losing the network must not bend it.

    The question deadline lives on the server, so a phone that drops out and
    comes back has to be handed the same remaining time everyone else is seeing —
    no credit for being offline, and no penalty either. A client that reconnects
    and is told a *fresh* window would be handing that student extra seconds.
    """
    code = new_room(token)
    a, b = [await join(code, f"{n}@clock.edu") for n in "ab"]
    host = await websockets.connect(f"{WS}/ws/host/{code}?token={token}")
    await host.send('{"type":"start"}')

    for ws in (a, b):
        while True:
            m = await recv_until(ws, "question")
            if m["phase"] == "answering":
                break
    opened, window = time.time(), m["remaining"]

    await a.close()                        # loses wifi mid-question
    await asyncio.sleep(3)
    a2 = await join(code, "a@clock.edu")   # ...and comes back
    back = await recv_until(a2, "question")

    expected = window - (time.time() - opened)
    drift = back["remaining"] - expected
    assert back["phase"] == "answering", "reconnect landed on the wrong phase"
    assert abs(drift) < 1.0, f"reconnect clock drifted {drift:+.2f}s from the room's"
    assert back["remaining"] < window, "reconnecting handed out a fresh window"
    print(f"  ok  clock survived a drop ({drift:+.2f}s drift, no fresh window)")

    for ws in (a2, b, host):
        await ws.close()


async def check_no_early_close_on_drop(token):
    """THE PILOT BUG. Two players answer, a third drops without answering.

    The old code re-tested "has every *connected* player answered?" on every
    disconnect, so the question slammed shut the instant the third socket died —
    cutting off everyone who was mid-reconnect. The answer clock must run instead.
    """
    code = new_room(token)
    a, b, c = [await join(code, f"{n}@a.edu") for n in "abc"]
    host = await websockets.connect(f"{WS}/ws/host/{code}?token={token}")
    await host.send('{"type":"start"}')

    for ws in (a, b, c):
        m = await recv_until(ws, "question")
        assert m["phase"] == "reading" and "options" not in m, "options leaked during reading"
    for ws in (a, b, c):
        m = await recv_until(ws, "question")
        assert m["phase"] == "answering" and m["options"] == ["3", "4"]

    opened = time.time()
    await a.send('{"type":"answer","option":1}')
    await c.send('{"type":"answer","option":1}')
    await b.close()                       # the flaky one, never answered

    await recv_until(a, "results", timeout=ANSWER + 6)
    held = time.time() - opened
    assert held > ANSWER - 1.5, (
        f"question closed after {held:.1f}s — a disconnect still ends it early")
    print(f"  ok  drop did not end the question early (ran {held:.1f}s of {ANSWER}s)")
    for ws in (a, c, host):
        await ws.close()


async def check_early_close_still_works(token):
    """...but the fast path must survive: everyone connected answers -> move on."""
    code = new_room(token)
    a, b = [await join(code, f"{n}@b.edu") for n in "ab"]
    host = await websockets.connect(f"{WS}/ws/host/{code}?token={token}")
    await host.send('{"type":"start"}')
    for ws in (a, b):
        await recv_until(ws, "question")          # reading
        await recv_until(ws, "question")          # answering
    opened = time.time()
    await a.send('{"type":"answer","option":1}')
    await b.send('{"type":"answer","option":0}')
    await recv_until(a, "results", timeout=ANSWER + 3)
    held = time.time() - opened
    assert held < ANSWER - 1, f"all answered but still waited {held:.1f}s"
    print(f"  ok  all answered -> closed early ({held:.1f}s)")
    for ws in (a, b, host):
        await ws.close()


async def check_answer_after_reconnect(token):
    """A phone that drops mid-question, comes back and re-sends its answer must
    be scored. This is the server half of the client's held-answer retry."""
    code = new_room(token)
    a = await join(code, "a@c.edu")
    host = await websockets.connect(f"{WS}/ws/host/{code}?token={token}")
    await host.send('{"type":"start"}')
    await recv_until(a, "question")
    await recv_until(a, "question")
    await a.close()                                    # dropped before answering

    a2 = await join(code, "a@c.edu")                   # same seat, new socket
    resume = await recv_until(a2, "question", timeout=5)
    assert resume["phase"] == "answering", "did not resume into the open question"
    assert "your_answer" not in resume, "server claims an answer it never received"
    await a2.send('{"type":"answer","option":1}')

    res = await recv_until(a2, "results", timeout=ANSWER + 6)
    assert res["your_score"] > 0, "answer after reconnect scored nothing"
    print(f"  ok  answer after reconnect scored {res['your_score']}")
    for ws in (a2, host):
        await ws.close()


def check_save_without_running(token):
    """?run=false saves the quiz and spawns nothing. Building a quiz must never
    commit the host to hosting it — and must never leave a joinable room behind."""
    title = "Save-only check"
    saved = post("/api/quiz?run=false", {
        "title": title, "capacity": 5,
        "questions": [{"text": "2+2?", "options": ["3", "4"], "correct": 1, "timer": 20}],
    }, token)
    assert saved["room_code"] is None, f"save-only spawned room {saved['room_code']}"

    act = get("/api/activity", token)
    assert title not in [r["title"] for r in act["live"]], "save-only left a live room"
    row = next((r for r in act["rows"] if r["title"] == title), None)
    assert row, "save-only did not save the quiz"

    # tidy up after ourselves: saved quizzes roll off at SAVED_QUIZZES, so a
    # check that leaves litter every run eventually evicts a real quiz
    delete(f"/api/quizzes/{row['quiz_id']}", token)
    print("  ok  save-only saved the quiz, spawned no room")


async def main():
    token = post("/api/login", {"username": USER, "password": PASS})["token"]
    check_gzip()
    check_save_without_running(token)
    code = new_room(token)
    await check_pong(code)
    await check_host_pong(code, token)
    await check_join_mid_question(token)
    await check_open_question_waits_for_the_host(token)
    await check_anonymous_needs_no_typing(token)
    await check_clock_is_universal(token)
    await check_no_early_close_on_drop(token)
    await check_early_close_still_works(token)
    await check_answer_after_reconnect(token)
    print("\nall resilience checks passed")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except AssertionError as e:
        print(f"\nFAILED: {e}")
        sys.exit(1)
