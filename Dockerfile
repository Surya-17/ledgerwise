# One image, one service: FastAPI serves both the API and the built React app.

# --- 1. Build the frontend ------------------------------------------------------------
FROM node:22-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- 2. Runtime -------------------------------------------------------------------------
FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY backend/requirements.txt ./
RUN pip install -r requirements.txt
COPY backend/ ./
COPY --from=web /web/dist ./static
ENV STATIC_DIR=/app/static PORT=8000
RUN useradd --create-home appuser
USER appuser
EXPOSE 8000
# Migrations run on boot. Fine for a single instance; with several, run them as a
# separate release step instead so two instances never migrate at once.
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
