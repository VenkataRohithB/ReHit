"""Every feature, driven end to end against a live server.

test_quiz.py unit-tests the engine and test_resilience.py covers flaky-network
failure modes. This one asks a different question: with a real server, real
websockets and real hosts and phones, does each switch and each screen actually
do what the builder promised?

    docker compose exec app python /srv/test_features.py

Each check prints one line. Any assertion failure stops the run.
"""
import asyncio
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import websockets

BASE = os.getenv("BASE", "http://localhost:8000")
WS = BASE.replace("http", "ws")
USER = os.getenv("ADMIN_USER", "Admin")
PASS = os.getenv("ADMIN_PASS", "AUACAD@2026")
READ = int(os.getenv("READ_SECS", "5"))     # reading phase before options open

_n = 0


def _title(kind):
    global _n
    _n += 1
    return f"feat-{kind}-{int(time.time())}-{_n}"


def api(path, body=None, token=None, method=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method or ("POST" if body is not None else "GET"),
        headers={"Content-Type": "application/json",
                 **({"Authorization": "Bearer " + token} if token else {})})
    with urllib.request.urlopen(req) as r:
        return json.load(r) if r.status != 204 else None


def login():
    return api("/api/login", {"username": USER, "password": PASS})


def make_quiz(token, questions, mode=None, run=True, capacity=50, title=None):
    body = {"title": title or _title("q"), "capacity": capacity,
            "questions": questions, "mode": mode or {}}
    r = api(f"/api/quiz?run={'true' if run else 'false'}", body, token)
    return r["room_code"], body["title"]


def q(text="Q", options=("a", "b", "c"), correct=0, timer=None, **extra):
    return {"text": text, "options": list(options), "correct": correct,
            "timer": timer if timer is not None else READ + 3, **extra}


async def host_sock(code, token):
    return await websockets.connect(f"{WS}/ws/host/{code}?token={token}")


async def play_sock(code, seat, name=""):
    return await websockets.connect(
        f"{WS}/ws/play/{code}?seat={urllib.parse.quote(seat)}"
        f"&name={urllib.parse.quote(name)}")


async def drain(ws, secs):
    """Everything that arrives within `secs`."""
    out, end = [], time.monotonic() + secs
    while True:
        left = end - time.monotonic()
        if left <= 0:
            return out
        try:
            out.append(json.loads(await asyncio.wait_for(ws.recv(), timeout=left)))
        except Exception:
            return out


async def collect(socks, secs):
    return await asyncio.gather(*(drain(w, secs) for w in socks))


def only(msgs, kind):
    return [m for m in msgs if m.get("type") == kind]


def last(msgs, kind, default=None):
    hits = only(msgs, kind)
    return hits[-1] if hits else default


async def shut(*socks):
    for w in socks:
        try:
            await w.close()
        except Exception:
            pass


def ok(msg):
    print(f"  ok  {msg}")


# ---------------------------------------------------------------- auth / REST
def check_auth():
    try:
        api("/api/login", {"username": USER, "password": PASS + "x"})
        raise AssertionError("a wrong password was accepted")
    except urllib.error.HTTPError as e:
        assert e.code == 401, e.code
    try:
        api("/api/activity", token="not-a-real-token")
        raise AssertionError("a forged token was accepted")
    except urllib.error.HTTPError as e:
        assert e.code == 401, e.code
    body = login()
    assert body["token"] and body["read_secs"] == READ
    assert set(body["limits"]) == {"questions", "options", "timer", "code"}
    ok("bad password and forged token both rejected; limits ship with the session")
    return body["token"]


def check_validation(token):
    """The bounds the builder pre-checks are really enforced by the API."""
    bad = [
        ("no questions", {"title": _title("v"), "capacity": 10, "questions": []}),
        ("blank title", {"title": "   ", "capacity": 10, "questions": [q()]}),
        ("one option", {"title": _title("v"), "capacity": 10,
                        "questions": [q(options=["only"])]}),
        ("correct out of range", {"title": _title("v"), "capacity": 10,
                                  "questions": [q(correct=9)]}),
        ("timer 0", {"title": _title("v"), "capacity": 10, "questions": [q(timer=0)]}),
        ("capacity 0", {"title": _title("v"), "capacity": 0, "questions": [q()]}),
        ("bad image", {"title": _title("v"), "capacity": 10,
                       "questions": [q(image="javascript:alert(1)")]}),
        ("blank marked correct", {"title": _title("v"), "capacity": 10,
                                  "questions": [q(options=["", "a", "b"], correct=0)]}),
    ]
    for label, body in bad:
        try:
            api("/api/quiz?run=false", body, token)
            raise AssertionError(f"{label} was accepted")
        except urllib.error.HTTPError as e:
            assert e.code == 422, f"{label} -> {e.code}"
    # and a blank option below the answer keeps the answer where it was
    title = _title("v")
    api("/api/quiz?run=false", {"title": title, "capacity": 10, "questions": [
        q(options=["Paris", "", "Rome"], correct=0)]}, token)
    qid = next(r["quiz_id"] for r in api("/api/activity", token=token)["rows"]
               if r["title"] == title)
    saved = api(f"/api/quizzes/{qid}", token=token)["questions"][0]
    assert saved["options"] == ["Paris", "Rome"], saved["options"]
    assert saved["options"][saved["correct"]] == "Paris"
    api(f"/api/quizzes/{qid}", token=token, method="DELETE")
    ok(f"{len(bad)} malformed quizzes refused; blank options keep the answer key")


def check_quiz_lifecycle(token):
    """Save without running, reopen, re-run, delete."""
    mode = {"identity": "name", "grading": "feedback", "board": "never"}
    code, title = make_quiz(token, [q(correct=None), q(correct=None)],
                            mode=mode, run=False)
    assert code is None, "run=false must not spawn a room"
    row = next(r for r in api("/api/activity", token=token)["rows"]
               if r["title"] == title)
    assert row["questions"] == 2 and row["code"] is None
    full = api(f"/api/quizzes/{row['quiz_id']}", token=token)
    assert full["mode"]["identity"] == "name", "mode must survive a reopen"
    assert full["mode"]["grading"] == "feedback"
    ran = api(f"/api/quizzes/{row['quiz_id']}/run", None, token, method="POST")
    assert ran["room_code"], "a saved quiz must be runnable"
    info = api(f"/api/room/{ran['room_code']}")
    assert info["identity"] == "name", "the room honours the saved mode"
    api(f"/api/quizzes/{row['quiz_id']}", token=token, method="DELETE")
    assert not [r for r in api("/api/activity", token=token)["rows"]
                if r["quiz_id"] == row["quiz_id"]]
    ok("save-only, reopen with mode intact, re-run, delete")


def check_room_info_is_thin():
    """Unauthenticated, and says nothing a joiner should not know."""
    try:
        api("/api/room/ZZZZZZ")
        raise AssertionError("a missing room was not a 404")
    except urllib.error.HTTPError as e:
        assert e.code == 404
    ok("room lookup 404s cleanly for an unknown code")


# ------------------------------------------------------------------- identity
async def check_identity_modes(token):
    for kind in ("email", "name", "anonymous"):
        code, _ = make_quiz(token, [q()], mode={"identity": kind})
        assert api(f"/api/room/{code}")["identity"] == kind
        if kind == "email":
            p = await play_sock(code, "Someone@Example.EDU")
            got = last(await drain(p, 2), "joined")
            assert got["name"] == "someone@example.edu", got
        elif kind == "name":
            p = await play_sock(code, "dev-1", "  Ravi  ")
            got = last(await drain(p, 2), "joined")
            assert got["name"] == "Ravi", "whitespace is collapsed"
            clash = await play_sock(code, "dev-2", "ravi")
            err = last(await drain(clash, 2), "error")
            assert err and "taken" in err["msg"], err
            await shut(clash)
        else:
            p = await play_sock(code, "dev-1")
            got = last(await drain(p, 2), "joined")
            assert got["name"] and " " in got["name"], got
        await shut(p)
    ok("identity: email lowercased, names trimmed and unique, anonymous assigned")


async def check_capacity_and_reconnect(token):
    code, _ = make_quiz(token, [q()], capacity=2)
    a = await play_sock(code, "a@x.edu")
    b = await play_sock(code, "b@x.edu")
    await collect([a, b], 1.5)
    full = await play_sock(code, "c@x.edu")
    err = last(await drain(full, 2), "error")
    assert err and "full" in err["msg"].lower(), err
    await shut(full)
    # the same seat coming back is a reconnect, not a new player
    await shut(a)
    again = await play_sock(code, "a@x.edu")
    joined = last(await drain(again, 2), "joined")
    lob = last(await drain(again, 1), "lobby") or {}
    assert joined, "a known seat must be let back in"
    await shut(b, again)
    ok("capacity refuses the 3rd of 2; a returning seat reconnects")


# -------------------------------------------------------------------- scoring
async def run_one_question(token, mode, answers, timer=None, qkw=None):
    """Start a room, let `answers` = [(seat, option, delay)] play one question.
    Returns (host messages, {seat: player messages})."""
    code, _ = make_quiz(token, [q(timer=timer, **(qkw or {}))], mode=mode)
    tok = token
    h = await host_sock(code, tok)
    ps = {}
    for seat, _opt, _d in answers:
        ps[seat] = await play_sock(code, seat)
    await collect([h, *ps.values()], 1.2)
    await h.send(json.dumps({"type": "start"}))
    await collect([h, *ps.values()], READ + 0.8)

    async def answer(seat, opt, delay):
        await asyncio.sleep(delay)
        await ps[seat].send(json.dumps({"type": "answer", "option": opt}))

    await asyncio.gather(*(answer(s, o, d) for s, o, d in answers))
    hm, *pm = await collect([h, *ps.values()], 2.5)
    if mode.get("timing") == "open" or mode.get("grading") == "livepoll":
        await h.send(json.dumps({"type": "next"}))
        more = await collect([h, *ps.values()], 2.5)
        hm += more[0]
        pm = [a + b for a, b in zip(pm, more[1:])]
    return h, ps, hm, dict(zip(ps, pm))


async def check_scoring_modes(token):
    seats = [("fast@x.edu", 0, 0.0), ("slow@x.edu", 0, 1.5), ("wrong@x.edu", 1, 0.2)]

    h, ps, hm, pm = await run_one_question(token, {"scoring": "absolute"}, seats, timer=READ + 6)
    board = last(hm, "results")["leaderboard"]
    by = {r["name"]: r["score"] for r in board}
    assert by["fast@x.edu"] > by["slow@x.edu"] > 0, by
    assert by["wrong@x.edu"] == 0, by
    await shut(h, *ps.values())

    h, ps, hm, pm = await run_one_question(token, {"scoring": "flat"}, seats, timer=READ + 6)
    by = {r["name"]: r["score"] for r in last(hm, "results")["leaderboard"]}
    assert by["fast@x.edu"] == by["slow@x.edu"] == 1000, by
    assert by["wrong@x.edu"] == 0
    await shut(h, *ps.values())

    h, ps, hm, pm = await run_one_question(token, {"scoring": "none"}, seats, timer=READ + 6)
    res = last(hm, "results")
    assert "leaderboard" not in res, "no scoring means no board"
    for seat, msgs in pm.items():
        r = last(msgs, "results")
        assert "your_score" not in r, f"{seat} was scored anyway"
    await shut(h, *ps.values())

    h, ps, hm, pm = await run_one_question(
        token, {"scoring": "relative", "timing": "open"}, seats)
    by = {r["name"]: r["score"] for r in last(hm, "results")["leaderboard"]}
    assert by["fast@x.edu"] > by["slow@x.edu"] > 0, by
    await shut(h, *ps.values())
    ok("scoring: absolute and relative reward speed, flat is level, none scores nothing")


async def check_reveal_and_board(token):
    seats = [("a@x.edu", 0, 0.0), ("b@x.edu", 1, 0.1)]

    h, ps, hm, pm = await run_one_question(token, {"reveal": False}, seats, timer=READ + 5)
    res = last(hm, "results")
    assert "correct" not in res, "reveal:false must not ship the key"
    assert res["leaderboard"][0]["score"] > 0, "but it still scores"
    for msgs in pm.values():
        assert "correct" not in last(msgs, "results")
    await shut(h, *ps.values())

    h, ps, hm, pm = await run_one_question(token, {"board": "end"}, seats, timer=READ + 5)
    assert "leaderboard" not in last(hm, "results"), "board:end shows none per question"
    await shut(h, *ps.values())

    h, ps, hm, pm = await run_one_question(token, {"board": "never"}, seats, timer=READ + 5)
    assert "leaderboard" not in last(hm, "results")
    await shut(h, *ps.values())
    ok("reveal:false hides the key but still scores; board end/never stay off")


async def check_tie_ranks(token):
    seats = [("a@x.edu", 0, 0.0), ("b@x.edu", 0, 0.0), ("c@x.edu", 1, 0.1)]
    h, ps, hm, pm = await run_one_question(token, {"scoring": "flat"}, seats, timer=READ + 5)
    board = last(hm, "results")["leaderboard"]
    ranks = {r["name"]: r["rank"] for r in board}
    assert ranks["a@x.edu"] == ranks["b@x.edu"] == 1, ranks
    assert ranks["c@x.edu"] == 2, "a dense rank leaves no gap after a tie"
    await shut(h, *ps.values())
    ok("tied scores share rank 1 and the next distinct score is 2")


# ----------------------------------------------------------------------- flow
async def check_reading_phase_withholds_options(token):
    code, _ = make_quiz(token, [q()])
    h = await host_sock(code, token)
    p = await play_sock(code, "a@x.edu")
    await collect([h, p], 1.2)
    await h.send(json.dumps({"type": "start"}))
    hm, pmsg = await collect([h, p], 2.0)          # still inside the reading phase
    reading = [m for m in only(pmsg, "question") if m.get("phase") == "reading"]
    assert reading, "no reading phase arrived"
    assert "options" not in reading[-1], "options leaked during the reading beat"
    hm2, pm2 = await collect([h, p], READ + 1.5)
    answering = [m for m in only(pm2, "question") if m.get("phase") == "answering"]
    assert answering and answering[-1]["options"], "options must arrive at the reveal"
    await shut(h, p)
    ok("reading beat ships no options; they arrive when it ends")


async def check_open_question_shape(token):
    """The bug behind 'it shows a timer even on stays-open'."""
    code, _ = make_quiz(token, [q(timer=READ + 5)], mode={"timing": "open"})
    h = await host_sock(code, token)
    p = await play_sock(code, "a@x.edu")
    await collect([h, p], 1.2)
    await h.send(json.dumps({"type": "start"}))
    hm, _ = await collect([h, p], READ + 1.5)
    qs = only(hm, "question")
    read_msg = [m for m in qs if m.get("phase") == "reading"][-1]
    ans_msg = [m for m in qs if m.get("phase") == "answering"][-1]
    assert "remaining" in read_msg, "the reading beat is always on a clock"
    assert "remaining" not in ans_msg, "an open question must ship no countdown"
    assert "elapsed" in ans_msg, "it ships elapsed instead"
    # the console folds these together — a stale `remaining` is what drew a timer
    merged = {**{k: v for k, v in read_msg.items()
                 if k not in ("remaining", "window", "elapsed")}, **ans_msg}
    assert "remaining" not in merged, "merged state must not inherit the countdown"
    await shut(h, p)
    ok("open question ships elapsed and no countdown; merged state stays open")


async def check_waiting_gate(token):
    code, _ = make_quiz(token, [q(), q()])
    h = await host_sock(code, token)
    p = await play_sock(code, "a@x.edu")
    await collect([h, p], 1.2)
    await h.send(json.dumps({"type": "start"}))
    await collect([h, p], READ + 0.8)
    await p.send(json.dumps({"type": "answer", "option": 0}))
    await collect([h, p], 3.5)
    await h.send(json.dumps({"type": "next"}))
    hm, pm = await collect([h, p], 1.5)
    assert last(hm, "lobby")["state"] == "waiting", "the room must hold between questions"
    assert last(pm, "lobby")["state"] == "waiting", "phones go back to the join screen"
    late = await play_sock(code, "late@x.edu")
    lm = await drain(late, 1.5)
    assert last(lm, "joined"), "a latecomer must get in during the gate"
    hm2, pm2, lm2 = await collect([h, p, late], 1.5)
    assert not only(hm2, "question"), "nothing may start on its own"
    await h.send(json.dumps({"type": "begin"}))
    hm3, _, _ = await collect([h, p, late], READ + 1.5)
    assert only(hm3, "question"), "the host's press starts it"
    await shut(h, p, late)
    ok("every question after the first waits, lets people in, starts on the host")


async def check_leaderboard_is_the_hosts_to_reveal(token):
    seats = [("a@x.edu", 0, 0.0), ("b@x.edu", 1, 0.1)]
    h, ps, hm, pm = await run_one_question(token, {}, seats, timer=READ + 5)
    assert "leaderboard" in last(hm, "results"), "the console gets it at once"
    for seat, msgs in pm.items():
        assert "leaderboard" not in last(msgs, "results"), f"{seat} saw it early"
        assert "your_rank" in last(msgs, "results"), "but keeps its own rank"
    await h.send(json.dumps({"type": "board"}))
    _, *after = await collect([h, *ps.values()], 1.5)
    for seat, msgs in zip(ps, after):
        b = last(msgs, "board")
        assert b and b["leaderboard"], f"{seat} never got the reveal"
        assert b["your_rank"] >= 1
    await shut(h, *ps.values())
    ok("standings reach phones only when the host reveals them")


async def check_live_poll(token):
    seats = [("a@x.edu", 2, 0.0), ("b@x.edu", 2, 0.2), ("c@x.edu", 0, 0.4)]
    h, ps, hm, pm = await run_one_question(
        token, {"grading": "livepoll"}, seats, qkw={"correct": None})
    prog = [m for m in only(hm, "progress") if "tally" in m]
    assert prog, "the console never got a live tally"
    assert prog[-1]["tally"] == [1, 0, 2], prog[-1]["tally"]
    for seat, msgs in pm.items():
        leaked = [m for m in msgs if "tally" in m and m.get("type") != "results"]
        assert not leaked, f"{seat} received a live tally: {leaked[:1]}"
        r = last(msgs, "results")
        assert "leaderboard" not in r and "your_score" not in r
    res = last(hm, "results")
    assert res.get("poll") is True and res["tally"] == [1, 0, 2]
    assert "correct" not in res, "a poll has no answer key"
    await shut(h, *ps.values())
    ok("live poll: tally on the console only, never on a phone")


async def check_game_over_and_csv(token):
    code, title = make_quiz(token, [q(timer=READ + 3)], mode={"scoring": "flat"})
    h = await host_sock(code, token)
    a = await play_sock(code, "win@x.edu")
    b = await play_sock(code, "lose@x.edu")
    await collect([h, a, b], 1.2)
    await h.send(json.dumps({"type": "start"}))
    await collect([h, a, b], READ + 0.8)
    await a.send(json.dumps({"type": "answer", "option": 0}))
    await b.send(json.dumps({"type": "answer", "option": 1}))
    hm, am, bm = await collect([h, a, b], 3.5)
    await h.send(json.dumps({"type": "next"}))
    hm2, am2, bm2 = await collect([h, a, b], 3.0)
    over = last(hm + hm2, "game_over")
    assert over, "the room never finished"
    assert over["total_players"] == 2
    assert over["leaderboard"][0]["name"] == "win@x.edu"
    assert last(am + am2, "game_over"), "phones get the finale too"
    await shut(h, a, b)

    req = urllib.request.Request(BASE + f"/api/room/{code}/csv",
                                 headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(req) as r:
        csv = r.read().decode()
        assert "attachment" in r.headers.get("Content-Disposition", "")
    lines = csv.strip().splitlines()
    assert lines[0].startswith("name,score,q1_answer,q1_correct,q1_time"), lines[0]
    assert any(l.startswith("win@x.edu,1000") for l in lines), lines
    assert any(l.startswith("lose@x.edu,0") for l in lines), lines
    ok("game over ranks everyone; CSV exports with the right header and rows")
    return code, title


def check_exports(token, code, title):
    """All four downloads, on a room that has actually finished."""
    def fetch(path):
        req = urllib.request.Request(BASE + f"/api/room/{code}/{path}",
                                     headers={"Authorization": "Bearer " + token})
        with urllib.request.urlopen(req) as r:
            return r.read().decode(), r.headers.get("Content-Disposition", "")

    body, disp = fetch("report.json")
    rep = json.loads(body)
    assert "report.json" in disp and rep["quiz"]["room_code"] == code
    assert rep["questions"][0]["text"], "the question text must be in the report"
    assert rep["questions"][0]["correct_answer"], "and the answer key"
    assert rep["summary"]["participants"] == 2
    assert rep["participants"][0]["responses"], "and every response"

    body, disp = fetch("responses.csv")
    rows = body.strip().splitlines()
    assert "responses.csv" in disp
    assert rows[0].startswith("participant,rank,total_score,question_number,question")
    assert len(rows) == 1 + 2 * len(rep["questions"]), "a row per person per question"
    assert rep["questions"][0]["text"] in rows[1], "each row carries its question"

    body, disp = fetch("questions.csv")
    assert "questions.csv" in disp
    assert body.strip().splitlines()[0].startswith("question_number,question,correct_option")

    body, disp = fetch("csv")
    assert body.startswith("name,score,q1_answer"), "the gradebook is unchanged"
    ok("exports: report.json + responses.csv + questions.csv + the gradebook")


async def check_history_survives(token):
    rows = api("/api/activity", token=token)["rows"]
    done = [r for r in rows if r["winner"]]
    assert done, "no finished game made it into history"
    assert all(r["winner"].get("name") for r in done), "a winner is missing its name"
    ok(f"history holds {len(done)} finished games, every winner named")


# ----------------------------------------------------------------------- main
async def main():
    print(f"\nfeature sweep against {BASE}\n")
    token = check_auth()
    check_validation(token)
    check_quiz_lifecycle(token)
    check_room_info_is_thin()
    await check_identity_modes(token)
    await check_capacity_and_reconnect(token)
    await check_reading_phase_withholds_options(token)
    await check_open_question_shape(token)
    await check_waiting_gate(token)
    await check_leaderboard_is_the_hosts_to_reveal(token)
    await check_live_poll(token)
    await check_scoring_modes(token)
    await check_reveal_and_board(token)
    await check_tie_ranks(token)
    code, title = await check_game_over_and_csv(token)
    check_exports(token, code, title)
    await check_history_survives(token)
    print("\nall feature checks passed\n")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except AssertionError as e:
        print(f"\nFAILED: {e}\n")
        sys.exit(1)
