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
# ships with the image so the pre-flight check can be run against a live room
COPY backend/test_resilience.py .
COPY --from=frontend /fe/dist ./app/static
EXPOSE 8000
# in-memory state -> single worker only (see app/game.py note)
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
