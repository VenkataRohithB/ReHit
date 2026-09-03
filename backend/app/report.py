"""The full record of a finished game.

build_csv (game.py) is a gradebook: one row per student, one column trio per
question. It answers "what did each student score" and nothing else — the
question text, the options, the answer key and every aggregate live only in the
host's head once the room is gone.

This module builds the whole picture instead: what was asked, what the room
answered, how each question performed, and how each person did. One dict, from
which every download format is rendered, and which is stored verbatim at archive
time so a finished game keeps its report after a restart.
"""
import csv
import io
import statistics
import time

KEYS = "ABCDEF"


def _letter(i):
    return KEYS[i] if 0 <= i < len(KEYS) else str(i + 1)


def _iso(ts):
    if not ts:
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(ts))


def _status(ans):
    """How to read a missing answer. 'absent' is not 'skipped': someone who
    joined at question 4 never had the chance, and averaging them in as a wrong
    answer quietly punishes them for arriving late."""
    if ans is None or ans.get("absent"):
        return "absent"
    return "answered" if isinstance(ans.get("option"), int) else "skipped"


def _pct(part, whole):
    return round(100 * part / whole, 1) if whole else 0.0


def build_report(room):
    """Everything about one game, as plain data."""
    from .game import rank_players, dense_ranks

    ranking = rank_players(room.players.values())
    ranks = dense_ranks(ranking)
    nq = len(room.questions)
    graded = room.mode["grading"] == "graded"
    scored = room.mode["scoring"] != "none"

    def answer_of(p, i):
        return p.answers[i] if i < len(p.answers) else None

    # ---------------- per question ----------------
    questions = []
    for i, q in enumerate(room.questions):
        opts = q["options"]
        correct = q.get("correct") if graded else None
        rows = [(p, answer_of(p, i)) for p in ranking]
        answered = [(p, a) for p, a in rows if _status(a) == "answered"]
        skipped = [p for p, a in rows if _status(a) == "skipped"]
        absent = [p for p, a in rows if _status(a) == "absent"]
        counts = [0] * len(opts)
        for _, a in answered:
            counts[a["option"]] += 1
        times = [a["time"] for _, a in answered if a.get("time") is not None]
        n_correct = sum(1 for _, a in answered if a.get("correct"))

        # the wrong option that pulled the most people — the one worth talking
        # about when you go back over the question
        distractor = None
        if correct is not None:
            wrong = [(n, j) for j, n in enumerate(counts) if j != correct and n]
            if wrong:
                n, j = max(wrong)
                distractor = {"option": _letter(j), "text": opts[j], "count": n,
                              "percent": _pct(n, len(answered))}

        pct_correct = _pct(n_correct, len(answered)) if correct is not None else None
        questions.append({
            "number": i + 1,
            "text": q["text"],
            "timer_seconds": q.get("timer"),
            "code": q.get("code"),
            "image": q.get("image"),
            "correct_option": _letter(correct) if correct is not None else None,
            "correct_answer": opts[correct] if correct is not None else None,
            "options": [{
                "option": _letter(j), "text": t, "is_correct": j == correct,
                "count": counts[j], "percent": _pct(counts[j], len(answered)),
            } for j, t in enumerate(opts)],
            "stats": {
                "answered": len(answered),
                "skipped": len(skipped),
                "absent": len(absent),
                "correct": n_correct if correct is not None else None,
                "incorrect": len(answered) - n_correct if correct is not None else None,
                "percent_correct": pct_correct,
                # a share of those who could answer, not of the whole room
                "response_rate": _pct(len(answered), len(answered) + len(skipped)),
                "average_seconds": round(statistics.fmean(times), 2) if times else None,
                "fastest_seconds": round(min(times), 2) if times else None,
                "slowest_seconds": round(max(times), 2) if times else None,
                "difficulty": _band(pct_correct),
                "top_distractor": distractor,
            },
        })

    # ---------------- per participant ----------------
    participants = []
    for p in ranking:
        responses = []
        for i, q in enumerate(room.questions):
            a = answer_of(p, i)
            st = _status(a)
            opt = a["option"] if st == "answered" else None
            responses.append({
                "question_number": i + 1,
                "status": st,
                "option": _letter(opt) if opt is not None else None,
                "answer": q["options"][opt] if opt is not None else None,
                "is_correct": bool(a.get("correct")) if st == "answered" and graded else None,
                "points": a.get("points") if st == "answered" else 0,
                "seconds": a.get("time") if st == "answered" else None,
            })
        could = [r for r in responses if r["status"] != "absent"]
        did = [r for r in responses if r["status"] == "answered"]
        right = [r for r in did if r["is_correct"]]
        participants.append({
            "name": p.name,
            "rank": ranks[p.email],
            "score": p.score,
            "answered": len(did),
            "skipped": len(could) - len(did),
            "absent": nq - len(could),
            "correct": len(right) if graded else None,
            "accuracy_percent": _pct(len(right), len(did)) if graded and did else None,
            "total_seconds": round(p.total_time, 2),
            "responses": responses,
        })

    # ---------------- headline ----------------
    scores = [p["score"] for p in participants]
    accs = [p["accuracy_percent"] for p in participants
            if p["accuracy_percent"] is not None]
    ranked_qs = [q for q in questions if q["stats"]["percent_correct"] is not None]
    summary = {
        "participants": len(participants),
        "questions": nq,
        "average_score": round(statistics.fmean(scores), 1) if scores and scored else None,
        "median_score": round(statistics.median(scores), 1) if scores and scored else None,
        "highest_score": max(scores) if scores and scored else None,
        "lowest_score": min(scores) if scores and scored else None,
        "average_accuracy_percent": round(statistics.fmean(accs), 1) if accs else None,
        "total_responses": sum(q["stats"]["answered"] for q in questions),
        "possible_responses": len(participants) * nq,
        "hardest_question": min(
            ranked_qs, key=lambda q: q["stats"]["percent_correct"])["number"]
        if ranked_qs else None,
        "easiest_question": max(
            ranked_qs, key=lambda q: q["stats"]["percent_correct"])["number"]
        if ranked_qs else None,
    }

    ended = room.ended_at or time.time()
    return {
        "quiz": {
            "title": room.title or "Untitled quiz",
            "room_code": room.code,
            "started": _iso(room.created),
            "ended": _iso(room.ended_at),
            "duration_seconds": round(ended - room.created, 1),
            "mode": dict(room.mode),
            "graded": graded,
            "scored": scored,
        },
        "summary": summary,
        "questions": questions,
        "participants": participants,
    }


def _band(pct):
    """A word for how the question went, so a skim does not need arithmetic."""
    if pct is None:
        return None
    if pct >= 80:
        return "easy"
    if pct >= 50:
        return "moderate"
    if pct >= 25:
        return "hard"
    return "very hard"


# ---------------------------------------------------------------- rendering
def _safe(v):
    """Neutralise a cell a spreadsheet would run as a formula.

    Player names are typed by students in name mode, so this really is untrusted
    input landing in a file the teacher opens in Excel. Numbers are left alone —
    prefixing "-5" would corrupt a perfectly good answer to a maths question.
    """
    if not isinstance(v, str) or not v or v[0] not in "=+-@\t\r":
        return v
    try:
        float(v)
        return v
    except ValueError:
        return "'" + v


def responses_csv(report):
    """One row per answer — the tidy shape for a pivot table or an AI prompt.

    Every row carries the question text and the answer text, so a single file is
    readable on its own without cross-referencing anything.
    """
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["participant", "rank", "total_score", "question_number", "question",
                "status", "option", "answer", "correct_option", "correct_answer",
                "is_correct", "points", "seconds"])
    by_num = {q["number"]: q for q in report["questions"]}
    for p in report["participants"]:
        for r in p["responses"]:
            q = by_num[r["question_number"]]
            w.writerow([_safe(x) for x in [
                p["name"], p["rank"], p["score"], r["question_number"], q["text"],
                r["status"], r["option"], r["answer"],
                q["correct_option"], q["correct_answer"],
                "" if r["is_correct"] is None else int(r["is_correct"]),
                r["points"], r["seconds"],
            ]])
    return buf.getvalue()


def questions_csv(report):
    """One row per question: how the room did on it."""
    buf = io.StringIO()
    w = csv.writer(buf)
    # only as many option columns as the widest question actually has
    widest = max((len(q["options"]) for q in report["questions"]), default=0)
    keys = KEYS[:widest]
    w.writerow(["question_number", "question", "correct_option", "correct_answer",
                "answered", "skipped", "absent", "correct", "percent_correct",
                "difficulty", "average_seconds", "top_distractor",
                *[f"count_{k}" for k in keys]])
    for q in report["questions"]:
        s = q["stats"]
        counts = {o["option"]: o["count"] for o in q["options"]}
        w.writerow([_safe(x) for x in [
            q["number"], q["text"], q["correct_option"], q["correct_answer"],
            s["answered"], s["skipped"], s["absent"], s["correct"],
            s["percent_correct"], s["difficulty"], s["average_seconds"],
            (s["top_distractor"] or {}).get("text", ""),
            *[counts.get(k, "") for k in keys],
        ]])
    return buf.getvalue()
