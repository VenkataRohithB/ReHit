"""FastAPI transport layer: REST + WebSockets + SPA hosting."""
import asyncio
import base64
import contextlib
import hashlib
import hmac
import logging
import os
import time
from pathlib import Path

from fastapi import (
    FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Header, Query, Depends,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import Response, FileResponse
from fastapi.staticfiles import StaticFiles

from . import store
from .config import settings
from .game import RoomManager, build_csv, rank_players
from .models import LoginReq, QuizIn

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("quiz")


def archive(room):
    """Persist a finished room so history and CSV outlive the process."""
    top = [{"name": p.name, "score": p.score}
           for p in rank_players(room.players.values())[:3]]
    store.save(room, build_csv(room), top)
    log.info("room %s archived (%d players)", room.code, len(room.players))


manager = RoomManager(settings, on_end=archive)


# ---------- auth ----------
# Signed, self-contained tokens: nothing is kept server-side, so a restart no
# longer logs the admin out. The default secret is derived from the credentials,
# so changing the password invalidates existing sessions.
def _secret():
    return (os.getenv("SECRET_KEY")
            or f"{settings.admin_user}:{settings.admin_pass}").encode()


def make_token(ttl=settings.session_secs):
    body = f"{settings.admin_user}:{int(time.time()) + ttl}"
    sig = hmac.new(_secret(), body.encode(), hashlib.sha256).hexdigest()[:32]
    raw = f"{body}:{sig}".encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def valid_token(token: str) -> bool:
    try:
        raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)).decode()
        body, sig = raw.rsplit(":", 1)
        _, exp = body.rsplit(":", 1)
        good = hmac.new(_secret(), body.encode(), hashlib.sha256).hexdigest()[:32]
        return hmac.compare_digest(sig, good) and int(exp) > time.time()
    except Exception:
        return False


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    stop = asyncio.Event()

    async def reaper():
        while not stop.is_set():
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=60)
            manager.reap()

    store.init()
    task = asyncio.create_task(reaper())
    log.info("quiz app started")
    yield
    stop.set()
    task.cancel()
    manager.shutdown()
    log.info("quiz app stopped")


app = FastAPI(title="Quiz Live", lifespan=lifespan)
# The whole class loads the bundle within a few seconds of each other, and every
# byte crosses whatever link the host is on. Uncompressed that is ~290KB a head
# (~20MB for a full room); gzipped it is closer to 80KB. On a phone tether or a
# free tunnel that difference decides whether the last students get in at all.
app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_origins.split(",")],
    allow_methods=["*"],
    allow_headers=["*"],
)


def require_admin(authorization: str = Header(None)):
    token = (authorization or "").replace("Bearer ", "").strip()
    if not valid_token(token):
        raise HTTPException(401, "Unauthorized")
    return token


# ---------- REST ----------
@app.get("/api/health")
def health():
    return {"status": "ok", "rooms": len(manager.rooms)}


@app.post("/api/login")
def login(req: LoginReq):
    ok = hmac.compare_digest(req.username, settings.admin_user) and \
        hmac.compare_digest(req.password, settings.admin_pass)
    if not ok:
        raise HTTPException(401, "Invalid credentials")
    # read_secs and the bounds travel with the session: the paste box pre-checks
    # against them so it can point at the offending line, and hardcoding a second
    # copy in the browser means an env-tuned limit quietly disagrees with the API
    return {"token": make_token(), "read_secs": settings.read_secs,
            "limits": {"questions": settings.max_questions, "options": settings.max_options,
                       "timer": settings.max_timer, "code": settings.max_code_chars}}


@app.post("/api/quiz")
def create_quiz(quiz: QuizIn, run: bool = True, _: str = Depends(require_admin)):
    """Save a quiz. With ?run=false that is all it does — no room is spawned, so
    building a quiz never commits you to hosting it. `room_code` is then null."""
    questions = [q.model_dump() for q in quiz.questions]
    # the save happens either way, and first: it must not depend on a room
    store.save_quiz(quiz.title, quiz.capacity, questions, quiz.mode)
    code = manager.create(quiz.capacity, questions, quiz.title, quiz.mode) if run else None
    log.info("quiz saved: %r (%d questions, cap %d)%s", quiz.title, len(questions),
             quiz.capacity, f" — room {code}" if code else "")
    return {"room_code": code, "title": quiz.title}


@app.get("/api/room/{code}")
def room_info(code: str):
    """What a joiner needs before being asked for anything: which kind of name
    this room wants, and whether it exists at all. Unauthenticated on purpose —
    it says less than the join page already does to someone holding the code."""
    room = manager.get(code)
    if not room:
        raise HTTPException(404, "Room not found")
    return {"identity": room.mode["identity"], "title": room.title, "state": room.state}


@app.get("/api/activity")
def activity(_: str = Depends(require_admin)):
    """Everything the dashboard shows: rooms live right now, and one row per
    quiz with the result of its last run. Never includes question content."""
    live = [{"code": r.code, "title": r.title or "Untitled quiz",
             "questions": len(r.questions), "players": len(r.players),
             "state": r.state, "created": r.created}
            for r in manager.rooms.values() if r.state != "ended"]
    live.sort(key=lambda r: r["created"], reverse=True)
    return {"live": live, "rows": store.activity()}


@app.get("/api/quizzes/{qid}")
def saved_quiz(qid: int, _: str = Depends(require_admin)):
    """Full definition — only fetched when a quiz is opened for editing."""
    quiz = store.quiz_by_id(qid)
    if not quiz:
        raise HTTPException(404, "No saved quiz with that id")
    return quiz


@app.post("/api/quizzes/{qid}/run")
def run_saved_quiz(qid: int, _: str = Depends(require_admin)):
    """Start a fresh room from a saved quiz. The questions never leave the server."""
    quiz = store.quiz_by_id(qid)
    if not quiz:
        raise HTTPException(404, "No saved quiz with that id")
    code = manager.create(quiz["capacity"], quiz["questions"], quiz["title"], quiz["mode"])
    store.touch_quiz(qid)
    log.info("room %s created from saved quiz %r", code, quiz["title"])
    return {"room_code": code, "title": quiz["title"]}


@app.delete("/api/quizzes/{qid}")
def remove_quiz(qid: int, _: str = Depends(require_admin)):
    if not store.delete_quiz(qid):
        raise HTTPException(404, "No saved quiz with that id")
    return {"deleted": qid}


@app.get("/api/room/{code}/csv")
def export_csv(code: str, _: str = Depends(require_admin)):
    room = manager.get(code)
    if room:
        csv_text, title = build_csv(room), room.title
    else:
        csv_text, title = store.csv_for(code)
    if csv_text is None:
        raise HTTPException(404, "No results for that room")
    name = f"{code}_{store.slug(title)}.csv"
    return Response(
        csv_text,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


# ---------- WebSockets ----------
@app.websocket("/ws/play/{code}")
async def ws_play(ws: WebSocket, code: str, seat: str = Query(...), name: str = Query("")):
    """`seat` identifies the chair, not the person: an email in email mode, an
    opaque per-device id otherwise. It is never echoed back to the room."""
    await ws.accept()
    room = manager.get(code)
    if not room:
        await ws.send_json({"type": "error", "msg": "Room not found"})
        return await ws.close()
    seat = seat.strip().lower()
    if not seat:
        await ws.send_json({"type": "error", "msg": "Could not identify you — reload the page"})
        return await ws.close()

    player, err = room.add_or_reconnect(seat, name)
    if err:
        await ws.send_json({"type": "error", "msg": err})
        return await ws.close()

    old = player.ws
    player.ws = ws
    if old is not None and old is not ws:
        # same email reconnecting (usually a page refresh) — retire the old socket
        with contextlib.suppress(Exception):
            await old.send_json({"type": "error", "msg": "You joined from another device"})
            await old.close()

    try:
        # the resolved name comes back: anonymous mode assigns one, and name mode
        # may have trimmed what was typed
        await ws.send_json({"type": "joined", "name": player.name, "state": room.state})
        await room.broadcast(room.lobby_msg())
        # someone walking in mid-question changes "answered of N"
        await room.send_hosts(room.progress_msg())
        # put them back on whatever screen the room is showing, not just questions
        resume = room.resume_msg_for(player)
        if resume:
            await ws.send_json(resume)

        while True:
            try:
                data = await ws.receive_json()
            except (WebSocketDisconnect, RuntimeError):
                break            # RuntimeError = receive after disconnect; do not spin
            except Exception:
                continue         # ignore a malformed frame, keep the connection
            kind = data.get("type")
            if kind == "ping":
                await ws.send_json({"type": "pong"})
            elif kind == "answer":
                room.record_answer(seat, data.get("option"))
                # carries the live tally too when this is a poll — hosts only
                await room.send_hosts(room.progress_msg())
    finally:
        # only clear if we are still the live socket — a reconnect that took this
        # player over already installed its own, and must not be unregistered here
        if player.ws is ws:
            player.ws = None
            # Deliberately NOT closing the question here. Ending it the moment the
            # last *connected* player has answered sounds right, but on classroom
            # wifi a burst of drops shrinks "connected" to the handful who already
            # answered and the question slams shut on everyone mid-reconnect. The
            # answer clock in run() already bounds the wait; let it do that.
            with contextlib.suppress(Exception):
                await room.broadcast(room.lobby_msg())
                await room.send_hosts(room.progress_msg())


@app.websocket("/ws/host/{code}")
async def ws_host(ws: WebSocket, code: str, token: str = Query(...)):
    await ws.accept()
    if not valid_token(token):
        await ws.send_json({"type": "error", "msg": "Unauthorized"})
        return await ws.close()
    room = manager.get(code)
    if not room:
        await ws.send_json({"type": "error", "msg": "Room not found"})
        return await ws.close()

    room.hosts.add(ws)
    try:
        await ws.send_json(room.lobby_msg())
        # a host who refreshes mid-game lands back on the current screen too
        if room.state in ("reading", "question"):
            await ws.send_json(room.question_msg(host=True))
        elif room.state == "results" and room.last_results:
            await ws.send_json({**room.last_results,
                                **({"leaderboard": room.last_board["leaderboard"]}
                                   if room.last_board else {})})
        elif room.state == "ended" and room.final_msg:
            await ws.send_json(room.final_msg)

        while True:
            try:
                data = await ws.receive_json()
            except (WebSocketDisconnect, RuntimeError):
                break
            except Exception:
                continue
            kind = data.get("type")
            if kind == "ping":
                # the console can sit silent on a results screen for minutes — it
                # heartbeats like the players do, and must get an answer
                await ws.send_json({"type": "pong"})
            elif kind == "start" and manager.start(room):
                await ws.send_json({"type": "started"})
            elif kind == "begin":
                room.request_begin()
            elif kind == "board":
                # the room sees the leaderboard on the host's word, not the
                # instant it was computed
                await room.send_board()
            elif kind == "next":
                room.request_next()
    finally:
        room.hosts.discard(ws)


# ---------- SPA (built frontend, optional) ----------
DIST = Path(__file__).parent / "static"


class ImmutableStatic(StaticFiles):
    """Vite fingerprints every filename under /assets, so the contents can never
    change behind a given URL — they are safe to cache forever.

    This matters more than it looks. A class does not trickle in: 100 students
    open the link inside the same half-minute, and that is a ~13MB burst of
    identical bytes. With a long max-age a CDN serves it from the edge and the
    origin sees almost none of it, and a student who reloads pays nothing.
    Without it every phone re-fetches the lot from us."""

    def file_response(self, *args, **kwargs):
        resp = super().file_response(*args, **kwargs)
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return resp


if (DIST / "index.html").exists():
    app.mount("/assets", ImmutableStatic(directory=DIST / "assets"), name="assets")

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        # Real files in dist/ (favicon.svg, robots.txt, …) have to win over the
        # SPA fallback: without this the browser gets index.html under a
        # text/html type and the icon silently never loads. resolve() + the
        # containment check keep "../" out of the served tree.
        if full_path:
            asset = (DIST / full_path).resolve()
            if asset.is_file() and asset.is_relative_to(DIST.resolve()):
                return FileResponse(asset)
        return FileResponse(DIST / "index.html")
