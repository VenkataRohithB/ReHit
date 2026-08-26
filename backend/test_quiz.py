"""Engine self-check (no deps): cd backend && python3 test_quiz.py"""
import json
import os
import tempfile
import time

os.environ.setdefault("DB_PATH", os.path.join(tempfile.gettempdir(), "quiz-test.db"))

from app.game import (  # noqa: E402
    Room, Player, score_answer, rank_players, build_csv, split_timer,
)


def mkroom(nq=1, timer=20):
    qs = [{"text": f"Q{i}", "options": ["a", "b", "c"], "correct": 1, "timer": timer}
          for i in range(nq)]
    return Room("TEST", 60, qs, advance_timeout=900, title="Test quiz")


def test_saved_quizzes_roll_over():
    """Same title updates in place; only the newest N survive."""
    from app import store
    from app.config import settings
    store.init()
    with store._conn() as c:
        c.execute("DELETE FROM quizzes")

    q = [{"text": "Q", "options": ["a", "b"], "correct": 0, "timer": 20}]
    store.save_quiz("Week 1", 60, q)
    store.save_quiz("Week 1", 30, q)                       # same name -> replaces
    saved = store.quiz_summaries()
    assert len(saved) == 1 and saved[0]["capacity"] == 30, saved

    # the list view must carry a count, never the questions themselves
    assert saved[0]["questions"] == 1, saved[0]
    assert "correct" not in json.dumps(saved), "answers must not leak into the list"

    full = store.quiz_by_id(saved[0]["id"])
    assert full["questions"][0]["text"] == "Q", "full definition still fetchable by id"
    assert store.quiz_by_id(99999) is None

    for n in range(2, settings.saved_quizzes + 4):         # overflow the cap
        store.save_quiz(f"Week {n}", 60, q)
    saved = store.quiz_summaries()
    assert len(saved) == settings.saved_quizzes, len(saved)
    titles = [s["title"] for s in saved]
    assert titles[0] == f"Week {settings.saved_quizzes + 3}", "newest first"
    assert "Week 1" not in titles, "oldest should have rolled off"
    assert store.delete_quiz(saved[0]["id"]) and not store.delete_quiz(99999)


def test_history_rolls_over_too():
    from app import store
    from app.config import settings
    store.init()
    with store._conn() as c:
        c.execute("DELETE FROM rooms")
    for n in range(settings.history_limit + 5):
        r = mkroom()
        # stamp in the past so these cannot outrank rooms saved by later tests
        r.code, r.ended_at = f"R{n:04d}", time.time() - 1000 + n
        store.save(r, "email,score\n", [])
    # ask for more than the limit keeps, or this asserts against the page size
    kept = store.recent(settings.history_limit + 5)
    assert len(kept) == settings.history_limit, len(kept)
    assert kept[0]["code"] == f"R{settings.history_limit + 4:04d}", "newest first"


def test_csv_filename_slug():
    from app import store
    assert store.slug("Week 3 — DSA Quiz!") == "week-3-dsa-quiz"
    assert store.slug("   ") == "results"
    assert len(store.slug("x" * 200)) <= 40


def test_resume_puts_you_back_on_the_current_screen():
    """Reconnecting must replay whatever screen the room is on. Without this a
    phone that drops during results sits on a dead question screen until the
    next question — which, now the host paces the game, can be minutes."""
    r = mkroom(nq=2)
    p = Player("a@x.com")
    p.score = 900
    p.answers = [{"option": 0, "time": 1.0, "correct": True, "points": 900}]
    r.players["a@x.com"] = p

    r.state = "lobby"
    assert r.resume_msg_for(p) is None

    r.state = "question"
    r.q_index, r.q_ends = 0, time.time() + 7
    msg = r.resume_msg_for(p)
    assert msg["type"] == "question"
    assert 6 < msg["remaining"] <= 7, msg["remaining"]     # time left, not a stamp
    r.responses["a@x.com"] = (0, 1.0)
    assert r.resume_msg_for(p)["your_answer"] == 0         # locked answer restored

    r.state = "results"
    r.last_results = {"type": "results", "index": 0, "tally": [1, 0]}
    r.last_ranks = {"a@x.com": 1}
    msg = r.resume_msg_for(p)
    assert msg["type"] == "results"
    assert msg["your_score"] == 900 and msg["your_rank"] == 1 and msg["gained"] == 900

    r.state = "ended"
    r.final_msg = {"type": "game_over", "leaderboard": []}
    assert r.resume_msg_for(p)["type"] == "game_over"


def test_timer_splits_into_reading_then_answering():
    """A 25s question is 5s of reading + 20s of answering, and the reading time
    is trimmed rather than eating the whole answer window on short questions."""
    assert split_timer(25, 5) == (5, 20)      # the case you described
    assert split_timer(20, 5) == (5, 15)
    assert split_timer(5, 5) == (4, 1)        # always at least 1s to answer
    assert split_timer(3, 5) == (2, 1)
    assert split_timer(1, 5) == (0, 1)        # no room to read at all
    assert split_timer(25, 0) == (0, 25)      # feature switched off


def test_scoring_uses_the_answer_window_not_the_whole_timer():
    """Answering the instant options appear is full marks, even though 5 of the
    question's 25 seconds were already spent reading."""
    r = Room("T", 60, [{"text": "Q", "options": ["a", "b"], "correct": 0, "timer": 25}],
             advance_timeout=900, read_secs=5)
    r.read_len, r.answer_len = split_timer(25, 5)
    assert (r.read_len, r.answer_len) == (5, 20)
    p = Player("a@x.com"); r.players["a@x.com"] = p

    r.state = "question"
    r.q_start = time.time()                    # clock starts at the reveal
    r.record_answer("a@x.com", 0)
    opt, t = r.responses["a@x.com"]
    assert t < 0.1, t
    assert score_answer(True, t, r.answer_len) >= 995, "instant answer must be ~full marks"
    # half the ANSWER window, not half of 25
    assert score_answer(True, 10, r.answer_len) == 750


def test_options_are_withheld_while_reading():
    r = Room("T", 60, [{"text": "Q", "options": ["a", "b"], "correct": 0, "timer": 25}],
             advance_timeout=900, read_secs=5)
    r.q_index, r.read_len, r.answer_len = 0, 5, 20
    r.state = "reading"; r.read_ends = time.time() + 5
    msg = r.question_msg()
    assert msg["phase"] == "reading" and "options" not in msg, msg
    assert 4 < msg["remaining"] <= 5 and msg["window"] == 5

    r.state = "question"; r.q_ends = time.time() + 20
    msg = r.question_msg()
    assert msg["phase"] == "answering" and msg["options"] == ["a", "b"]
    assert msg["window"] == 20


def test_answers_during_reading_are_ignored():
    r = Room("T", 60, [{"text": "Q", "options": ["a", "b"], "correct": 0, "timer": 25}],
             advance_timeout=900, read_secs=5)
    r.q_index, r.read_len, r.answer_len = 0, 5, 20
    r.players["a@x.com"] = Player("a@x.com")
    r.state = "reading"
    r.record_answer("a@x.com", 0)
    assert r.responses == {}, "no answering before the options are up"


def test_remaining_never_goes_negative():
    r = mkroom()
    r.q_index, r.q_ends = 0, time.time() - 5      # question already expired
    assert r.question_msg()["remaining"] == 0.0


def test_next_only_advances_from_results():
    """The host's Next is ignored unless the room is actually showing results,
    so a stray click cannot skip a live question."""
    r = mkroom()
    r.state = "question"
    assert r.request_next() is False
    assert not r.advance.is_set(), "a question must not be skippable by Next"
    r.state = "results"
    assert r.request_next() is True
    assert r.advance.is_set()


def test_scoring():
    assert score_answer(True, 0, 20) == 1000     # instant correct
    assert score_answer(True, 20, 20) == 500      # last-second correct
    assert score_answer(True, 10, 20) == 750      # halfway
    assert score_answer(False, 0, 20) == 0        # wrong
    assert score_answer(True, 999, 20) == 500     # clamp overshoot


def test_rank_tiebreak():
    a, b, c = Player("a"), Player("b"), Player("c")
    a.score, a.total_time = 1000, 5.0
    b.score, b.total_time = 1000, 2.0   # same score, earlier -> first
    c.score, c.total_time = 500, 1.0
    assert [p.email for p in rank_players([a, b, c])] == ["b", "a", "c"]


def test_early_finish_ignores_disconnected():
    """v1 bug: a player who answered then dropped could close the question early."""
    r = mkroom()
    r.state = "question"
    for e in ("a", "b", "c"):
        p = Player(e)
        p.ws = object()          # 'connected'
        r.players[e] = p
    r.responses["a"] = (1, 2.0)
    r.players["a"].ws = None      # answered then disconnected
    r.check_all_answered()
    assert not r.all_answered.is_set()   # b, c still owe answers
    r.responses["b"] = (1, 3.0)
    r.check_all_answered()
    assert not r.all_answered.is_set()   # c still connected, no answer
    r.responses["c"] = (0, 4.0)
    r.check_all_answered()
    assert r.all_answered.is_set()       # now everyone connected has answered


def test_join_rules():
    r = mkroom()
    r.capacity = 2
    p1, e1 = r.add_or_reconnect("x")
    assert e1 is None and p1
    p1.ws = object()
    r.add_or_reconnect("y")
    _, full = r.add_or_reconnect("z")    # capacity 2 reached
    assert full == "Room is full"
    r.state = "question"
    _, late = r.add_or_reconnect("new")
    assert late == "Game already started"


def test_refresh_takes_over_and_keeps_score():
    """A refresh reconnects the same email, keeps the score, and does not
    consume a second slot even while the old socket is still open."""
    r = mkroom()
    r.capacity = 1
    p, err = r.add_or_reconnect("x")
    assert err is None
    p.ws, p.score = object(), 750
    again, err2 = r.add_or_reconnect("x")   # refresh, old socket still attached
    assert err2 is None
    assert again is p and again.score == 750
    assert len(r.players) == 1             # no slot leaked


def test_board_deltas():
    r = mkroom()
    for e, s in (("a", 10), ("b", 20), ("c", 30)):
        p = Player(e); p.score = s; r.players[e] = p
    ranking = rank_players(r.players.values())          # c, b, a
    assert [row["email"] for row in r.board(ranking)] == ["c", "b", "a"]
    assert all(row["delta"] == 0 for row in r.board(ranking)), "no history yet"
    r.prev_rank = {"c": 3, "b": 2, "a": 1}              # pretend a used to lead
    rows = r.board(ranking)
    by = {row["email"]: row["delta"] for row in rows}
    assert by["c"] == 2 and by["b"] == 0 and by["a"] == -2, by
    prev = [i + 1 + row["delta"] for i, row in enumerate(rows)]
    assert sorted(prev) == [1, 2, 3], "deltas must rebuild a valid previous ranking"


def test_csv():
    r = mkroom(nq=2)
    p = Player("x@y.com")
    r.players["x@y.com"] = p
    p.score = 900
    p.answers = [{"option": 1, "time": 2.0, "correct": True, "points": 900},
                 {"option": None, "time": None, "correct": False, "points": 0}]
    out = build_csv(r)
    lines = out.strip().splitlines()
    assert lines[0] == "email,score,q1_answer,q1_correct,q1_time,q2_answer,q2_correct,q2_time"
    assert lines[1].startswith("x@y.com,900,b,1,2.0,")


def test_history_roundtrip():
    """A finished room survives into sqlite and its CSV is still downloadable."""
    from app import store
    import time
    store.init()
    r = mkroom(nq=2)
    r.code = "HIST01"
    r.ended_at = time.time()
    p = Player("z@y.com"); p.score = 1200
    p.answers = [{"option": 1, "time": 1.0, "correct": True, "points": 1200},
                 {"option": None, "time": None, "correct": False, "points": 0}]
    r.players["z@y.com"] = p
    store.save(r, build_csv(r), [{"email": "z@y.com", "score": 1200}])
    row = next(x for x in store.recent(10) if x["code"] == "HIST01")
    assert row["players"] == 1 and row["questions"] == 2
    assert row["top"][0]["email"] == "z@y.com"
    assert row["title"] == "Test quiz", row["title"]
    csv_text, title = store.csv_for("HIST01")
    assert "z@y.com" in csv_text and title == "Test quiz"
    store.save(r, build_csv(r), [])          # re-save must not raise on duplicate code
    assert store.csv_for("NOPE00") == (None, "")


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
    print("all engine tests passed")
