import logging
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.exc import IntegrityError

from app.config import settings
from app.errors import DomainError
from app.routers import accounts, auth, budgets, entries, imports, reports, rules

logger = logging.getLogger("ledgerwise")

app = FastAPI(
    title="Ledgerwise API",
    version="0.1.0",
    description="Double-entry personal finance ledger with idempotent writes and an audit trail.",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Idempotent-Replayed"],
)


@app.exception_handler(DomainError)
def handle_domain_error(_: Request, exc: DomainError) -> JSONResponse:
    return JSONResponse({"detail": str(exc), **exc.extra}, status_code=exc.status_code)


@app.exception_handler(IntegrityError)
def handle_integrity_error(_: Request, exc: IntegrityError) -> JSONResponse:
    # Usually a lost race on a unique constraint (e.g. two concurrent reversals).
    logger.info("Integrity error: %s", exc.orig)
    return JSONResponse(
        {"detail": "The request conflicts with the current state; please retry"}, status_code=409
    )


for module in (auth, accounts, entries, imports, rules, budgets, reports):
    app.include_router(module.router, prefix="/api")


@app.get("/api/health", tags=["meta"])
def health() -> dict[str, str]:
    return {"status": "ok"}


# Serve the built frontend from the same origin in production: one service, no CORS.
if settings.static_dir and Path(settings.static_dir, "index.html").is_file():
    static_root = Path(settings.static_dir).resolve()
    app.mount("/assets", StaticFiles(directory=static_root / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str) -> FileResponse:
        if path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")
        candidate = (static_root / path).resolve()
        if path and candidate.is_file() and candidate.is_relative_to(static_root):
            return FileResponse(candidate)  # favicon, robots.txt, ...
        return FileResponse(static_root / "index.html")  # client-side routes
