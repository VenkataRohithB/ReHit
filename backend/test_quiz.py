"""Engine self-check (no deps): cd backend && python3 test_quiz.py"""
import json
import os
import tempfile
import time

os.environ.setdefault("DB_PATH", os.path.join(tempfile.gettempdir(), "quiz-test.db"))
os.environ.setdefault("ADMIN_PASS", "test-only")

from app.game import (  # noqa: E402
    Room, Player, score_answer, rank_players, build_csv, split_timer, clean_mode,
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
    _, still_full = r.add_or_reconnect("new")
    assert still_full == "Room is full", "capacity must still hold mid-game"
    r.capacity = 5
    p, err = r.add_or_reconnect("new")
    assert err is None and p, "a new player should be able to join mid-game"
    r.state = "ended"
    _, done = r.add_or_reconnect("later")
    assert done == "This quiz has already finished"


def test_tied_scores_share_a_rank():
    """Level scores finish level, and the numbering does not skip: 1, 1, 2.
    Answer time still orders people inside a tie but no longer separates them."""
    from app.game import dense_ranks
    r = mkroom(nq=1)
    for email, score, t in [("a", 2400, 5.0), ("b", 2400, 9.0),
                            ("c", 1800, 3.0), ("d", 1800, 4.0), ("e", 900, 2.0)]:
        p = Player(email)
        p.score, p.total_time = score, t
        r.players[email] = p

    ranking = rank_players(r.players.values())
    ranks = dense_ranks(ranking)
    assert [ranks[p.email] for p in ranking] == [1, 1, 2, 2, 3], ranks
    assert ranks["a"] == ranks["b"] == 1, "tied top scores must share first place"
    assert ranks["e"] == 3, "dense ranking must not skip numbers after a tie"
    # the faster of a tied pair still sorts first, it just does not outrank
    assert [p.email for p in ranking][:2] == ["a", "b"], "time still orders within a tie"

    rows = r.board(ranking)
    assert [row["rank"] for row in rows] == [1, 1, 2, 2, 3]
    assert rows[0]["score"] == rows[1]["score"] == 2400


def test_late_joiner_rows_line_up_in_the_csv():
    """Someone arriving at Q3 must not have their answer land in the q1 columns.
    build_csv reads answers positionally, so the padding is what keeps it honest."""
    r = mkroom(nq=3)
    early = Player("early@y.com")
    r.players["early@y.com"] = early
    early.score = 900
    early.answers = [{"option": 1, "time": 1.0, "correct": True, "points": 900},
                     {"option": 0, "time": 2.0, "correct": False, "points": 0}]
    r.revealed = 2                       # Q1 and Q2 have been scored
    r.state = "question"

    late, err = r.add_or_reconnect("late@y.com")
    assert err is None and len(late.answers) == 2, "late joiner was not padded"
    late.answers.append({"option": 1, "time": 1.5, "correct": True, "points": 950})
    late.score = 950

    rows = {l.split(",")[0]: l.split(",") for l in build_csv(r).strip().splitlines()[1:]}
    cols = rows["late@y.com"]            # email, score, then 3 columns per question
    assert cols[2:5] == ["", "", ""], "Q1 should be empty — they were not in the room"
    assert cols[5:8] == ["", "", ""], "Q2 should be empty — they were not in the room"
    assert cols[8] == "b", f"their Q3 answer landed in the wrong column: {cols}"
    assert rows["early@y.com"][3] == "1", "the early player's row must be untouched"


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
    assert [row["name"] for row in r.board(ranking)] == ["c", "b", "a"]
    assert all(row["delta"] == 0 for row in r.board(ranking)), "no history yet"
    r.prev_rank = {"c": 3, "b": 2, "a": 1}              # pretend a used to lead
    rows = r.board(ranking)
    by = {row["name"]: row["delta"] for row in rows}
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
    assert lines[0] == "name,score,q1_answer,q1_correct,q1_time,q2_answer,q2_correct,q2_time"
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
    store.save(r, build_csv(r), [{"name": "z@y.com", "score": 1200}])
    row = next(x for x in store.recent(10) if x["code"] == "HIST01")
    assert row["players"] == 1 and row["questions"] == 2
    assert row["top"][0]["name"] == "z@y.com"
    assert row["title"] == "Test quiz", row["title"]
    csv_text, title = store.csv_for("HIST01")
    assert "z@y.com" in csv_text and title == "Test quiz"
    # a room archived before the email->name rename must still come back with a
    # name — the dashboard reads winner.name and a missing one blanks the page
    store.save(r, build_csv(r), [{"email": "old@y.com", "score": 5}])
    row = next(x for x in store.recent(10) if x["code"] == "HIST01")
    assert row["top"][0]["name"] == "old@y.com"
    assert store.activity()[0]["winner"]["name"]

    store.save(r, build_csv(r), [])          # re-save must not raise on duplicate code
    assert store.csv_for("NOPE00") == (None, "")


def test_mode_defaults_to_todays_behaviour():
    """An old sqlite row, a missing key or junk all come back as the quiz that
    used to run. /api/quizzes/{id}/run never touches pydantic, so this is the
    only thing standing between stored data and the engine."""
    from app.game import clean_mode
    was = {"identity": "email", "grading": "graded", "scoring": "absolute",
           "reveal": True, "board": "always", "timing": "countdown"}
    assert clean_mode({}) == was
    assert clean_mode(None) == was
    assert clean_mode({"scoring": "banana", "nope": 1}) == was, "junk must not leak through"
    assert set(clean_mode({"nope": 1})) == set(was), "the stored blob is exactly six keys"


def test_mode_dependencies_are_resolved_once():
    """The rules that make the degenerate screens unreachable rather than guarded."""
    from app.game import clean_mode
    m = clean_mode({"grading": "feedback", "board": "always", "scoring": "absolute"})
    assert m["scoring"] == "none", "a poll has nothing to score"
    assert m["board"] == "never", "and therefore nothing to rank"
    m = clean_mode({"timing": "open", "scoring": "absolute"})
    assert m["scoring"] == "relative", "an open question has no window for absolute speed"


def test_relative_scoring_spans_first_response_to_close():
    from app.game import score_relative
    assert score_relative(True, 2.0, 2.0, 10.0) == 1000    # first one in
    assert score_relative(True, 10.0, 2.0, 10.0) == 500    # answered as it closed
    assert score_relative(True, 6.0, 2.0, 10.0) == 750     # halfway
    assert score_relative(False, 2.0, 2.0, 10.0) == 0      # wrong is wrong
    assert score_relative(True, 5.0, 5.0, 5.0) == 1000     # lone responder
    assert score_relative(True, 3.0, 3.0, 2.0) == 1000     # close before first: guarded


def test_relative_window_starts_at_the_first_response_even_if_it_was_wrong():
    """`first` is the first RESPONSE, not the first correct one. Switching it to
    first-correct silently rescales everyone, so pin it."""
    r = mkroom(nq=1)
    r.mode = {**r.mode, "scoring": "relative"}
    r.answer_len = 30
    r.q_start = time.time() - 10
    for name, t in [("fast@x", 1.0), ("slow@x", 5.0)]:
        r.players[name] = Player(name)
        r.responses[name] = (0 if name.startswith("fast") else 1, t)  # fast one is WRONG
    score = r._scorer()
    # the correct answer came at t=5 in a window that opened at t=1
    assert score(True, 5.0) < 1000, "the wrong-but-fastest answer must still open the window"
    assert score(True, 1.0) == 1000


def test_a_null_answer_cannot_match_a_null_correct():
    """A poll has correct=None. Without a range guard `opt == correct` is
    None == None, and anyone sending a null option scores full marks."""
    r = mkroom(nq=1)
    r.questions[0]["correct"] = None
    r.players["a"] = Player("a")
    r.state = "question"
    r.q_start = time.time()
    for bad in (None, "1", 99, -1, True):
        r.record_answer("a", bad)
    assert r.responses == {}, f"a non-option was accepted: {r.responses}"
    r.record_answer("a", 1)
    assert r.responses["a"][0] == 1, "a real option must still go through"


def test_open_question_is_not_clamped_and_only_the_host_closes_it():
    r = mkroom(nq=1)
    r.mode = {**r.mode, "timing": "open"}
    r.timed = False
    r.answer_len = 20
    r.players["a"] = Player("a")
    r.state = "question"
    r.q_start = time.time() - 45        # open far longer than the nominal window
    r.record_answer("a", 1)
    assert r.responses["a"][1] > 20, "an open question must not clamp to answer_len"
    assert r.request_next() is True, "Finish must close a live open question"
    r2 = mkroom(nq=1)                   # ...but never a timed one
    r2.state = "question"
    assert r2.request_next() is False


def test_names_are_unique_and_a_refresh_keeps_the_seat():
    r = mkroom(nq=1)
    r.mode = {**r.mode, "identity": "name"}
    p, err = r.add_or_reconnect("device-1", "Priya")
    assert err is None and p.name == "Priya"
    _, clash = r.add_or_reconnect("device-2", "priya")
    assert clash and "taken" in clash, clash
    _, blank = r.add_or_reconnect("device-3", "   ")
    assert blank == "Enter a name to join"
    p.score = 700
    again, err = r.add_or_reconnect("device-1", "anything")
    assert err is None and again is p and again.score == 700, "refresh must keep the seat"


def test_anonymous_players_get_distinct_names():
    r = mkroom(nq=1)
    r.mode = {**r.mode, "identity": "anonymous"}
    names = set()
    for i in range(25):
        p, err = r.add_or_reconnect(f"dev-{i}", "")
        assert err is None
        names.add(p.name)
    assert len(names) == 25, f"generated a duplicate name: {len(names)}/25"


def test_board_and_answer_are_omitted_not_nulled():
    """Clients draw what they are given, so 'off' must mean absent."""
    import asyncio
    q = {"text": "Q", "options": ["a", "b"], "correct": 1, "timer": 20}

    def reveal(mode):
        r = Room("T", 60, [q], advance_timeout=900, mode=mode)
        r.answer_len = 20
        r.players["a"] = Player("a")
        r.q_start = time.time()
        r.responses["a"] = (1, 1.0)
        asyncio.run(r._reveal(0, r.questions[0]))
        return r

    # last_results is the PLAYER view and never carries the standings — the host
    # reveals those. last_board holds them until show_board() releases them.
    default = reveal({})
    assert "correct" in default.last_results
    assert "leaderboard" not in default.last_results, "the room must not get it early"
    assert default.last_board["leaderboard"][0]["score"] > 0

    hidden = reveal({"reveal": False})
    assert "correct" not in hidden.last_results, "reveal:false must not ship the answer"
    assert hidden.last_board["leaderboard"][0]["score"] > 0, "hiding the answer still scores"

    at_end = reveal({"board": "end"})
    assert at_end.last_board is None, "board:end shows nothing per question"

    live = reveal({"grading": "livepoll"})
    assert live.last_results["poll"] is True, "a console reconnecting still draws columns"
    assert "poll" not in default.last_results, "and a graded quiz is not flagged as one"

    poll = reveal({"grading": "feedback"})
    assert "correct" not in poll.last_results and poll.last_board is None
    assert poll.players["a"].score == 0, "a poll scores nothing"
    assert poll.last_results["tally"] == [0, 1], "but it still counts the votes"


def test_blank_options_move_the_answer_key_with_them():
    """The browser used to do this remap on its own; any other client posting
    here got a silently wrong answer key. Now the API owns it."""
    from app.models import QuestionIn
    import pydantic

    # the blank sits ABOVE the answer, so a naive strip promotes "Rome"
    q = QuestionIn(text="Capital of France?", options=["", "Paris", "Rome"], correct=1)
    assert q.options == ["Paris", "Rome"]
    assert q.options[q.correct] == "Paris", q.options[q.correct]

    # blanks below the answer, and several of them, leave it where it is
    q = QuestionIn(text="Q?", options=["  ", "a", "", "b", "  "], correct=1)
    assert q.options == ["a", "b"] and q.options[q.correct] == "a"

    # marking a blank correct is a mistake, not a silent conversion to a poll
    try:
        QuestionIn(text="Q?", options=["", "a", "b"], correct=0)
        raise AssertionError("a blank marked correct must be rejected")
    except pydantic.ValidationError as e:
        assert "blank" in str(e)

    # a poll keeps no answer key, and still drops its blanks
    q = QuestionIn(text="Q?", options=["a", "", "b"], correct=None)
    assert q.options == ["a", "b"] and q.correct is None


def test_login_ships_the_limits_the_api_enforces():
    """The paste box pre-checks against these; a hardcoded second copy in the
    browser would quietly disagree with the API once one is env-tuned."""
    from app.config import settings
    from app.main import login
    from app.models import LoginReq

    body = login(LoginReq(username=settings.admin_user, password=settings.admin_pass))
    assert body["limits"] == {
        "questions": settings.max_questions, "options": settings.max_options,
        "timer": settings.max_timer, "code": settings.max_code_chars,
    }


def test_the_room_sees_the_leaderboard_only_when_the_host_reveals_it():
    """The host steps results -> leaderboard. Sending the standings with the
    results put them on every phone while the projector was still on the bars."""
    import asyncio
    r = mkroom()
    r.answer_len = 20
    r.players["a"] = Player("a")
    r.q_start = time.time()
    r.responses["a"] = (1, 1.0)
    asyncio.run(r._reveal(0, r.questions[0]))

    p = r.players["a"]
    assert "leaderboard" not in r.results_msg_for(p), "not before the host says so"
    assert not r.board_shown
    assert r.resume_msg_for(p)["type"] == "results", "a refresh stays on the bars"

    assert r.show_board() is True
    assert r.board_shown
    board = r.board_msg_for(p)
    assert board["type"] == "board" and board["leaderboard"][0]["score"] > 0
    assert board["your_rank"] == 1
    resumed = r.resume_msg_for(p)
    assert resumed["type"] == "board", "a refresh now returns to it"
    # and rebuilds the whole screen, not just the standings
    assert resumed["leaderboard"] and resumed["options"] == ["a", "b", "c"]
    assert resumed["your_score"] == p.score

    # a poll has no standings, so a stray click cannot manufacture a payload
    poll = Room("P", 60, r.questions, advance_timeout=900, mode={"grading": "feedback"})
    poll.state = "results"
    assert poll.show_board() is False


def test_live_poll_forces_its_own_shape():
    """`livepoll` is ungraded and host-closed: a countdown would cut the room
    off mid-thought, and there is nothing to score or rank."""
    from app.game import clean_mode
    m = clean_mode({"grading": "livepoll", "timing": "countdown", "scoring": "absolute",
                    "board": "always"})
    assert m["grading"] == "livepoll"
    assert m["timing"] == "open", "the host closes a poll, not a clock"
    assert m["scoring"] == "none" and m["board"] == "never"
    # every other switch is still free
    assert clean_mode({"grading": "livepoll", "identity": "anonymous"})["identity"] == "anonymous"


def test_the_live_tally_reaches_the_host_and_never_a_phone():
    """The whole point of a projected poll is that the room looks up. A phone
    that could see the running count would also let a late answerer follow it."""
    r = Room("T", 60, [{"text": "Q", "options": ["a", "b", "c"], "correct": None,
                        "timer": 20}], advance_timeout=900, mode={"grading": "livepoll"})
    r.state = "question"
    r.q_index = 0
    r.q_start = time.time()
    for seat in ("a", "b", "c"):
        r.players[seat] = Player(seat)
    assert r.record_answer("a", 2) is True
    r.record_answer("b", 2)

    host = r.progress_msg()
    assert host["tally"] == [0, 0, 2], host
    assert host["answered"] == 2 and host["total"] == 3

    # question_msg() with no argument is the PHONE payload. It is broadcast to
    # every device in the room, so anything in it is public — the tally, the
    # answered count and the room size all have to stay out of it.
    for leak in ("tally", "answered", "players"):
        assert leak not in r.question_msg(), f"a phone must not receive {leak!r}"
    assert r.question_msg(host=True)["tally"] == [0, 0, 2], "but the console does"

    # a non-poll never produces one at all, for either side
    plain = Room("T2", 60, r.questions, advance_timeout=900, mode={"grading": "feedback"})
    plain.state = "question"; plain.q_index = 0; plain.q_start = time.time()
    plain.players["a"] = Player("a")
    plain.record_answer("a", 1)
    assert "tally" not in plain.question_msg(host=True)
    assert "tally" not in plain.progress_msg()

    graded = mkroom()
    graded.state = "question"; graded.q_index = 0; graded.q_start = time.time()
    graded.players["a"] = Player("a")
    graded.record_answer("a", 1)
    assert "tally" not in graded.question_msg(host=True)


def test_the_host_knows_the_room_size_before_the_first_answer():
    """The console used to read "0 of 0 answered" until someone tapped, and the
    denominator then tracked live sockets, so it fell as phones went to sleep."""
    r = mkroom()
    r.state = "question"
    r.q_index = 0
    r.q_start = time.time()
    for seat in ("a", "b", "c"):
        r.players[seat] = Player(seat)

    opened = r.question_msg(host=True)
    assert opened["answered"] == 0 and opened["players"] == 3, opened

    r.record_answer("a", 1)
    assert r.progress_msg() == {"type": "progress", "answered": 1, "total": 3}
    # nobody is connected in this test, so a connected-count denominator would
    # have reported "1 of 0" here
    assert r.connected_count() == 0


def test_every_question_after_the_first_waits_for_the_host():
    """The quiz opens on a lobby; so does every question after it. Latecomers
    get a door between questions, and nothing starts until the host says go."""
    import asyncio

    async def drive():
        r = mkroom(nq=2, timer=1)
        r.read_secs = 0
        r.players["a"] = Player("a")
        task = asyncio.create_task(r.run())

        # question 1 runs straight out of the opening lobby — no extra gate
        await asyncio.sleep(0.05)
        assert r.state == "question" and r.q_index == 0, r.state
        r.record_answer("a", 1)
        await asyncio.sleep(1.2)
        assert r.state == "results", r.state

        r.request_next()                       # leave the results
        await asyncio.sleep(0.05)
        # ...and the room is now HOLDING, not asking question 2
        assert r.state == "waiting", r.state
        assert r.q_index == 1, "queued up, but not started"

        # someone can still walk in, and lands on the join screen
        late, err = r.add_or_reconnect("late@x.edu")
        assert err is None and late is not None
        assert r.resume_msg_for(late) is None, "a joiner waits with everyone else"
        assert r.lobby_msg()["state"] == "waiting"

        assert r.request_begin() is True
        await asyncio.sleep(0.05)
        assert r.state == "question" and r.q_index == 1, r.state

        # and `begin` outside the waiting screen does nothing
        assert r.request_begin() is False
        task.cancel()

    asyncio.run(drive())


def test_a_host_press_during_the_fan_out_is_not_swallowed():
    """The waiters used to clear their own event. By the time they ran, the
    state accepting the press was already live and the broadcast to the room had
    already yielded — so a host pressing during the fan-out had the press
    cleared out from under them and the room hung until the 15-minute backstop.
    With a full class the fan-out is slow enough to make that the normal case."""
    import asyncio

    async def drive():
        r = mkroom(nq=2, timer=1)
        r.read_secs = 0
        r.players["a"] = Player("a")
        task = asyncio.create_task(r.run())
        await asyncio.sleep(0.05)
        r.record_answer("a", 1)
        await asyncio.sleep(1.2)
        assert r.state == "results", r.state

        # press the instant results exist — before run() reaches its waiter
        assert r.request_next() is True
        await asyncio.sleep(0.05)
        assert r.state == "waiting", f"the press was swallowed: {r.state}"

        # and again on the waiting gate, before _await_begin() gets scheduled
        assert r.request_begin() is True
        await asyncio.sleep(0.05)
        assert r.state == "question" and r.q_index == 1, r.state
        task.cancel()

    asyncio.run(drive())


def test_an_open_question_closes_on_a_press_made_the_moment_it_opens():
    """Same race on the other gate: `next` closes an open question, and the
    press can land while the question is still being fanned out."""
    import asyncio

    async def drive():
        r = mkroom(nq=1, timer=1)
        r.read_secs = 0
        r.mode = clean_mode({"timing": "open"})
        r.timed = False
        r.players["a"] = Player("a")
        task = asyncio.create_task(r.run())
        await asyncio.sleep(0.05)
        assert r.state == "question"
        r.record_answer("a", 1)
        assert r.request_next() is True
        await asyncio.sleep(0.1)
        assert r.state == "results", f"the open question never closed: {r.state}"
        task.cancel()

    asyncio.run(drive())


def test_a_reconnect_during_a_broadcast_is_not_hung_up():
    """The fan-out cleanup used to re-read player.ws AFTER awaiting the sends.
    A phone that dropped and came straight back already had its NEW socket on
    the player by then, so the cleanup for the DEAD send cleared the fresh
    socket and hung it up. On classroom wifi that is the normal case, so a
    student could be kicked out repeatedly for as long as the room broadcast."""
    import asyncio

    class DeadSock:
        async def send_json(self, msg):
            raise ConnectionError("this phone is already gone")

        async def close(self):
            pass

    class LiveSock:
        def __init__(self):
            self.sent = []

        async def send_json(self, msg):
            self.sent.append(msg)

        async def close(self):
            raise AssertionError("the fresh socket must not be hung up")

    async def drive():
        r = mkroom()
        p = Player("a")
        dead, fresh = DeadSock(), LiveSock()
        p.ws = dead
        r.players["a"] = p

        async def reconnect_mid_flight():
            await asyncio.sleep(0)        # let the failing send be in flight
            p.ws = fresh                  # the phone is back on a new socket

        await asyncio.gather(r.broadcast({"type": "lobby"}), reconnect_mid_flight())
        assert p.ws is fresh, "the reconnect was cleared by the dead send's cleanup"

        # and a send that fails with no reconnect behind it still unregisters
        p.ws = DeadSock()
        await r.broadcast({"type": "lobby"})
        assert p.ws is None, "a genuinely dead socket must still be dropped"

    asyncio.run(drive())


def test_a_drop_burst_cannot_slam_the_question_shut_on_reconnectors():
    """The early close excused disconnected players, so when a third of the room
    dropped, the remaining students answering ended the question — and the
    reconnecting third came back to a finished question having scored nothing."""
    r = mkroom()
    r.state = "question"
    r.q_index = 0
    r.q_start = time.time()
    r.answer_len = 20

    live, dropped = [], []
    for i in range(9):
        p = Player(f"p{i}")
        p.ws = object() if i < 6 else None      # 3 of 9 mid-reconnect
        (live if p.ws else dropped).append(p)
        r.players[p.email] = p

    for p in live:
        r.record_answer(p.email, 1)
    assert not r.all_answered.is_set(), \
        "the question closed while a third of the room was reconnecting"

    # they come back and answer; now the whole room is in and it closes
    for p in dropped:
        p.ws = object()
        r.record_answer(p.email, 1)
    assert r.all_answered.is_set(), "a fully answered room must still close early"
    assert len(r.responses) == 9, "every answer was kept"


def test_report_carries_what_the_gradebook_csv_never_could():
    """build_csv answers "what did each student score". The report has to answer
    what was asked, what the room picked, and how each question performed —
    none of which the CSV's q1_answer columns can express."""
    import asyncio
    from app.report import build_report, responses_csv, questions_csv

    r = Room("RPT001", 60, [
        {"text": "Capital of France?", "options": ["Paris", "Rome", "Berlin"],
         "correct": 0, "timer": 20},
        {"text": "2 + 2?", "options": ["3", "4"], "correct": 1, "timer": 20},
    ], advance_timeout=900, title="Geography")
    r.answer_len = 20
    for seat in ("a", "b", "c"):
        r.players[seat] = Player(seat)

    # q1: a and b right, c pulled to the same wrong option
    r.state = "question"; r.q_index = 0; r.q_start = time.time()
    r.responses = {"a": (0, 1.0), "b": (0, 2.0), "c": (1, 3.0)}
    asyncio.run(r._reveal(0, r.questions[0]))
    # q2: a right, b wrong, c never answers
    r.state = "question"; r.q_index = 1; r.q_start = time.time()
    r.responses = {"a": (1, 1.0), "b": (0, 2.0)}
    asyncio.run(r._reveal(1, r.questions[1]))
    r.ended_at = time.time()

    rep = build_report(r)
    assert rep["quiz"]["title"] == "Geography" and rep["quiz"]["room_code"] == "RPT001"
    assert rep["summary"]["participants"] == 3 and rep["summary"]["questions"] == 2

    q1, q2 = rep["questions"]
    assert q1["text"] == "Capital of France?", "the question text must be in the file"
    assert q1["correct_option"] == "A" and q1["correct_answer"] == "Paris"
    assert [o["count"] for o in q1["options"]] == [2, 1, 0]
    assert q1["stats"]["percent_correct"] == 66.7 and q1["stats"]["difficulty"] == "moderate"
    assert q1["stats"]["top_distractor"]["text"] == "Rome", "the wrong answer worth discussing"
    assert q2["stats"]["skipped"] == 1, "someone in the room who did not answer"
    assert rep["summary"]["hardest_question"] == 2

    # a skipped question is not a wrong answer, and carries no fake option
    c = next(p for p in rep["participants"] if p["name"] == "c")
    assert c["responses"][1]["status"] == "skipped"
    assert c["responses"][1]["answer"] is None and c["responses"][1]["points"] == 0

    # one row per answer, question and answer text spelled out on every line
    rows = responses_csv(rep).strip().splitlines()
    assert len(rows) == 1 + 3 * 2, "a row per participant per question"
    assert "Capital of France?" in rows[1] and "Paris" in rows[1]
    # and one row per question
    qrows = questions_csv(rep).strip().splitlines()
    assert len(qrows) == 3
    assert qrows[0].endswith("count_A,count_B,count_C"), "only as many columns as options"


def test_report_survives_the_room_it_describes():
    """The room is gone from memory minutes after it ends, so the report is
    stored rendered rather than rebuilt on demand."""
    from app import store
    from app.report import build_report
    store.init()
    r = mkroom(nq=1)
    r.code = "RPT002"
    r.ended_at = time.time()
    p = Player("z@y.com"); p.score = 900
    p.answers = [{"option": 1, "time": 1.0, "correct": True, "points": 900}]
    r.players["z@y.com"] = p

    store.save(r, build_csv(r), [{"name": "z@y.com", "score": 900}], build_report(r))
    got = store.report_for("RPT002")
    assert got["quiz"]["room_code"] == "RPT002"
    assert got["questions"][0]["text"] == "Q0", got["questions"][0]["text"]
    assert got["participants"][0]["responses"][0]["answer"] == "b"
    # a game archived before reports existed has none, and must not fake one
    store.save(r, build_csv(r), [], None)
    assert store.report_for("RPT002") is None
    assert store.report_for("NOPE00") is None


def test_a_formula_typed_as_a_name_cannot_run_in_a_spreadsheet():
    """In name mode a student types their own name, and it lands in a file the
    teacher opens in Excel. Numbers stay untouched — prefixing "-5" would
    corrupt a perfectly good answer to a maths question."""
    from app.report import _safe
    assert _safe("=cmd|'/c calc'!A1").startswith("'"), "a formula must be defused"
    assert _safe("@SUM(A1:A9)").startswith("'")
    assert _safe("-5") == "-5" and _safe("+3.5") == "+3.5", "numbers are left alone"
    assert _safe("Merge sort") == "Merge sort"


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
    print("all engine tests passed")
