"""Runtime settings, all overridable via environment variables."""
import os


def _int(name, default):
    try:
        return int(os.getenv(name, default))
    except ValueError:
        return int(default)


class Settings:
    admin_user = os.getenv("ADMIN_USER", "Admin")
    admin_pass = os.getenv("ADMIN_PASS", "Password123")

    # question is shown alone for this long before the options appear; the answer
    # clock (and therefore scoring) only starts once they do
    read_secs = _int("READ_SECS", 5)

    # the host advances between questions; this is only a backstop for a host
    # who closes the tab mid-game, so the room can finish and be reaped
    advance_timeout_secs = _int("ADVANCE_TIMEOUT_SECS", 900)
    room_ttl_secs = _int("ROOM_TTL_SECS", 3600)  # reap ended / abandoned rooms after this

    db_path = os.getenv("DB_PATH", "quiz.db")
    # both tables roll over — only the most recent rows are kept
    history_limit = _int("HISTORY_LIMIT", 10)    # finished games
    saved_quizzes = _int("SAVED_QUIZZES", 10)    # reusable quiz definitions
    max_title = _int("MAX_TITLE", 80)
    session_secs = _int("SESSION_SECS", 43200)   # admin session lifetime (12h)

    max_questions = _int("MAX_QUESTIONS", 50)
    max_code_chars = _int("MAX_CODE_CHARS", 2000)
    max_options = _int("MAX_OPTIONS", 6)
    max_capacity = _int("MAX_CAPACITY", 1000)
    max_timer = _int("MAX_TIMER", 300)

    # comma-separated; "*" allows all (fine when frontend is served by this app)
    cors_origins = os.getenv("CORS_ORIGINS", "*")


settings = Settings()
