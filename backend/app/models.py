"""Request validation. Bounds come from config so limits are env-tunable."""
import re

from pydantic import BaseModel, field_validator, model_validator

from .config import settings


class LoginReq(BaseModel):
    username: str
    password: str


class QuestionIn(BaseModel):
    text: str
    options: list[str]
    correct: int
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
        if not (0 <= self.correct < len(self.options)):
            raise ValueError("correct index out of range")
        return self


class QuizIn(BaseModel):
    title: str
    capacity: int
    questions: list[QuestionIn]

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
