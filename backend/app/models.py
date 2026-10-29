"""Request validation. Bounds come from config so limits are env-tunable."""
import re

from pydantic import BaseModel, field_validator, model_validator

from .config import settings
from .game import clean_mode


class LoginReq(BaseModel):
    username: str
    password: str


class QuestionIn(BaseModel):
    text: str
    options: list[str]
    # an index, or a list of them on a select-all question; a poll has no key
    correct: int | list[int] | None = None
    multi: bool = False          # "Select all that apply": ticks and a Submit
    timer: int = 20
    code: str | None = None    # optional snippet shown above the options
    image: str | None = None   # optional illustration, by URL

    @field_validator("text")
    @classmethod
    def _text(cls, v):
        v = v.strip()
        if not v:
            raise ValueError("question text required")
        return v

    @field_validator("code")
    @classmethod
    def _code(cls, v):
        if v is None:
            return None
        v = v.rstrip()                       # keep leading indentation, drop trailing blank lines
        if not v.strip():
            return None
        if len(v) > settings.max_code_chars:
            raise ValueError(f"code snippet must be under {settings.max_code_chars} characters")
        return v

    @field_validator("image")
    @classmethod
    def _image(cls, v):
        if v is None:
            return None
        v = v.strip()
        if not v:
            return None
        # this ends up in an <img src>, so only ever allow real web URLs
        if not re.match(r"^https?://", v, re.I):
            raise ValueError("image must be an http:// or https:// URL")
        return v

    @model_validator(mode="before")
    @classmethod
    def _blank_options(cls, data):
        """Drop blank options, and move `correct` with its own option.

        Before the field validators, because dropping a blank shifts every index
        after it: strip without remapping and a blank sitting above the answer
        silently promotes the option below it. The browser used to do this remap
        on its own, which left every other client posting here — a script, a
        re-save, a second UI — with a quietly wrong answer key.
        """
        if not isinstance(data, dict) or not isinstance(data.get("options"), list):
            return data
        opts = data["options"]
        kept = [i for i, o in enumerate(opts) if isinstance(o, str) and o.strip()]

        def remap(c):
            if isinstance(c, int) and not isinstance(c, bool) and 0 <= c < len(opts):
                if c not in kept:
                    raise ValueError("the option marked correct is blank")
                return kept.index(c)
            return c   # out-of-range indexes are left for _correct_in_range to reject
        correct = data.get("correct")
        correct = [remap(c) for c in correct] if isinstance(correct, list) else remap(correct)
        return {**data, "options": [opts[i].strip() for i in kept], "correct": correct}

    @field_validator("options")
    @classmethod
    def _options(cls, v):
        v = [o.strip() for o in v if o.strip()]
        if len(v) < 2:
            raise ValueError("at least 2 options required")
        if len(v) > settings.max_options:
            raise ValueError(f"at most {settings.max_options} options")
        return v

    @field_validator("timer")
    @classmethod
    def _timer(cls, v):
        if not (1 <= v <= settings.max_timer):
            raise ValueError(f"timer must be between 1 and {settings.max_timer}s")
        return v

    @model_validator(mode="after")
    def _correct_in_range(self):
        c = self.correct
        picks = c if isinstance(c, list) else [] if c is None else [c]
        if any(not (0 <= i < len(self.options)) for i in picks):
            raise ValueError("correct index out of range")
        # One shape per kind, settled here so the engine never guesses: a
        # select-all question keeps a sorted list (one item is fine), a single
        # answer keeps an int. Several marked correct makes it select-all.
        picks = sorted(set(picks))
        if len(picks) > 1:
            self.multi = True
        if self.multi:
            self.correct = picks or None
        else:
            self.correct = picks[0] if picks else None
        return self


class QuizIn(BaseModel):
    title: str
    capacity: int
    questions: list[QuestionIn]
    mode: dict = {}              # the six per-quiz switches; see game.MODES

    @field_validator("mode")
    @classmethod
    def _mode(cls, v):
        # clean_mode drops unknown keys and falls back to today's behaviour, so a
        # stale client cannot post a switch we do not have
        return clean_mode(v)

    @field_validator("title")
    @classmethod
    def _title(cls, v):
        v = " ".join(v.split())          # collapse whitespace; it is a display name
        if not v:
            raise ValueError("give the quiz a name so you can find it again")
        if len(v) > settings.max_title:
            raise ValueError(f"name must be under {settings.max_title} characters")
        return v

    @field_validator("capacity")
    @classmethod
    def _capacity(cls, v):
        if not (1 <= v <= settings.max_capacity):
            raise ValueError(f"capacity must be between 1 and {settings.max_capacity}")
        return v

    @field_validator("questions")
    @classmethod
    def _questions(cls, v):
        if not v:
            raise ValueError("at least one question required")
        if len(v) > settings.max_questions:
            raise ValueError(f"at most {settings.max_questions} questions")
        return v

    @model_validator(mode="after")
    def _select_all_needs_a_key(self):
        # graded select-all with nothing ticked would be unwinnable: under
        # all-or-nothing, picking nothing is not an answer
        # a default `mode` is never run through _mode, so settle it here too
        if clean_mode(self.mode)["grading"] == "graded":
            for i, q in enumerate(self.questions):
                if q.multi and q.correct is None:
                    raise ValueError(f"question {i + 1} needs at least one correct answer")
        return self
