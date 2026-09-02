"""Saved quizzes and finished-game history. sqlite3 is stdlib — no ORM, no
migrations framework, two tables.

Live games stay in memory (see game.py). This holds the things worth keeping:
the quiz definitions so they can be run again, and finished games so the
dashboard and CSV export survive a restart. Both tables roll over — only the
most recent rows are kept, so the file never grows without bound.
"""
import json
import re
import sqlite3
import time

from .config import settings

SCHEMA = """
CREATE TABLE IF NOT EXISTS rooms (
  code      TEXT PRIMARY KEY,
  created   REAL NOT NULL,
  ended     REAL NOT NULL,
  questions INTEGER NOT NULL,
  players   INTEGER NOT NULL,
  top       TEXT NOT NULL,   -- json [{name, score}] top 3
  csv       TEXT NOT NULL,   -- full export, rendered once at game end
  title     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS rooms_ended ON rooms(ended DESC);

CREATE TABLE IF NOT EXISTS quizzes (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  title     TEXT NOT NULL UNIQUE,   -- same title replaces: one entry per named quiz
  capacity  INTEGER NOT NULL,
  questions TEXT NOT NULL,          -- json ARRAY — quiz_summaries counts it in SQL
  created   REAL NOT NULL,
  used      REAL NOT NULL,
  mode      TEXT NOT NULL DEFAULT '{}'   -- json, the six per-quiz switches
);
CREATE INDEX IF NOT EXISTS quizzes_used ON quizzes(used DESC);
"""


def _conn():
    c = sqlite3.connect(settings.db_path, timeout=5)
    c.row_factory = sqlite3.Row
    return c


def init():
    with _conn() as c:
        # an earlier build keyed quizzes by title; move those rows onto ids
        old = {r["name"] for r in c.execute("PRAGMA table_info(quizzes)")}
        if old and "id" not in old:
            c.execute("ALTER TABLE quizzes RENAME TO quizzes_old")
            c.executescript(SCHEMA)
            c.execute("INSERT INTO quizzes (title, capacity, questions, created, used) "
                      "SELECT title, capacity, questions, created, used FROM quizzes_old")
            c.execute("DROP TABLE quizzes_old")
        c.executescript(SCHEMA)
        # databases created before rooms had titles predate the column
        cols = {r["name"] for r in c.execute("PRAGMA table_info(rooms)")}
        if "title" not in cols:
            c.execute("ALTER TABLE rooms ADD COLUMN title TEXT NOT NULL DEFAULT ''")
        # quizzes saved before the per-quiz switches existed; '{}' is the migration,
        # since clean_mode turns an empty dict back into the original behaviour
        qcols = {r["name"] for r in c.execute("PRAGMA table_info(quizzes)")}
        if "mode" not in qcols:
            c.execute("ALTER TABLE quizzes ADD COLUMN mode TEXT NOT NULL DEFAULT '{}'")


def _roll(c, table, order_col, keep):
    """Keep only the `keep` most recent rows. Table names are literals here."""
    c.execute(
        f"DELETE FROM {table} WHERE rowid NOT IN "
        f"(SELECT rowid FROM {table} ORDER BY {order_col} DESC LIMIT ?)", (keep,))


# ---------- saved quizzes ----------
def save_quiz(title, capacity, questions, mode=None):
    """Remember a quiz so it can be run again. Re-saving a title updates it."""
    now = time.time()
    with _conn() as c:
        c.execute(
            "INSERT INTO quizzes (title, capacity, questions, created, used, mode) "
            "VALUES (?,?,?,?,?,?) "
            "ON CONFLICT(title) DO UPDATE SET "
            "  capacity=excluded.capacity, questions=excluded.questions, "
            "  used=excluded.used, mode=excluded.mode",
            (title, capacity, json.dumps(questions), now, now, json.dumps(mode or {})))
        _roll(c, "quizzes", "used", settings.saved_quizzes)


def quiz_summaries():
    """List view — deliberately no questions, so the dashboard never ships
    every answer to the browser just to draw a list."""
    with _conn() as c:
        rows = c.execute(
            "SELECT id, title, capacity, created, used, "
            "       json_array_length(questions) AS questions "
            "FROM quizzes ORDER BY used DESC LIMIT ?", (settings.saved_quizzes,),
        ).fetchall()
    return [dict(r) for r in rows]


def quiz_by_id(qid):
    """Full definition — only fetched when a quiz is actually edited or run."""
    with _conn() as c:
        r = c.execute("SELECT id, title, capacity, questions, mode FROM quizzes WHERE id = ?",
                      (qid,)).fetchone()
    if not r:
        return None
    # `mode` must be in the column list above: without it the builder silently
    # loses a quiz's settings on edit and /run quietly runs it as a plain quiz
    return {**dict(r), "questions": json.loads(r["questions"]),
            "mode": json.loads(r["mode"] or "{}")}


def touch_quiz(qid):
    with _conn() as c:
        c.execute("UPDATE quizzes SET used = ? WHERE id = ?", (time.time(), qid))


def delete_quiz(qid):
    with _conn() as c:
        return c.execute("DELETE FROM quizzes WHERE id = ?", (qid,)).rowcount > 0


# ---------- finished games ----------
def save(room, csv_text, top):
    """Record a finished room. Re-running a code overwrites, so retries are safe."""
    with _conn() as c:
        c.execute(
            "INSERT OR REPLACE INTO rooms VALUES (?,?,?,?,?,?,?,?)",
            (room.code, room.created, room.ended_at or time.time(),
             len(room.questions), len(room.players), json.dumps(top), csv_text,
             getattr(room, "title", "")),
        )
        _roll(c, "rooms", "ended", settings.history_limit)


def recent(limit=10):
    with _conn() as c:
        rows = c.execute(
            "SELECT code, created, ended, questions, players, top, title "
            "FROM rooms ORDER BY ended DESC LIMIT ?", (limit,),
        ).fetchall()
    # rooms archived before players had a `name` stored the winner under `email`;
    # normalise on read so old history does not reach the UI missing a field
    return [{**dict(r), "top": [{**t, "name": t.get("name") or t.get("email", "")}
                                for t in json.loads(r["top"])]} for r in rows]


def activity():
    """One list for the dashboard: every quiz, newest first, carrying the result
    of the last time it was run. Quizzes and games are separate tables but the
    same thing to whoever is looking at the screen, so they are merged by name."""
    rooms = recent(settings.history_limit)      # newest first
    latest, untitled = {}, []
    for r in rooms:
        if r["title"]:
            latest.setdefault(r["title"], r)
        else:
            untitled.append(r)                  # rooms from before quizzes had names

    def row(q, r):
        top = (r or {}).get("top") or []
        return {
            "quiz_id": q["id"] if q else None,               # None -> cannot re-run
            "title": (q or r)["title"] or "Untitled quiz",
            "questions": (q or r)["questions"],
            "capacity": q["capacity"] if q else None,
            "last_run": q["used"] if q else r["ended"],
            "code": r["code"] if r else None,                # None -> never finished
            "players": r["players"] if r else None,
            "winner": top[0] if top else None,
        }

    rows = [row(q, latest.pop(q["title"], None)) for q in quiz_summaries()]
    rows += [row(None, r) for r in list(latest.values()) + untitled]
    rows.sort(key=lambda x: x["last_run"], reverse=True)
    return rows


def csv_for(code):
    with _conn() as c:
        row = c.execute("SELECT csv, title FROM rooms WHERE code = ?", (code,)).fetchone()
    return (row["csv"], row["title"]) if row else (None, "")


def slug(title):
    """Filename-safe form of a quiz title, for CSV downloads."""
    s = re.sub(r"[^A-Za-z0-9]+", "-", (title or "").strip()).strip("-").lower()
    return s[:40] or "results"
