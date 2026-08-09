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


def new_room(token, n_players=10):
    return post("/api/quiz", {
        "title": "Resilience", "capacity": n_players,
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
    ws = await websockets.connect(f"{WS}/ws/play/{code}?email={email}")
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


async def main():
    token = post("/api/login", {"username": USER, "password": PASS})["token"]
    check_gzip()
    code = new_room(token)
    await check_pong(code)
    await check_host_pong(code, token)
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
