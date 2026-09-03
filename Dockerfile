# ---- build the React frontend ----
FROM node:20-alpine AS frontend
WORKDIR /fe
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
RUN npm run build          # -> /fe/dist

# ---- run FastAPI, serving the built UI ----
FROM python:3.12-slim
WORKDIR /srv
ENV PYTHONUNBUFFERED=1
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/app ./app
# ship with the image so the pre-flight checks can be run against a live room:
#   docker compose exec app python /srv/test_resilience.py   flaky-network failures
#   docker compose exec app python /srv/test_features.py     every switch and screen
#   docker compose exec app python /srv/test_load.py         a full class, PLAYERS=50
COPY backend/test_resilience.py backend/test_features.py backend/test_load.py ./
COPY --from=frontend /fe/dist ./app/static
EXPOSE 8000
# in-memory state -> single worker only (see app/game.py note)
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
