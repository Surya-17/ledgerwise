import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from app.config import settings
from app.deps import DB
from app.errors import DomainError
from app.routers import accounts, auth, budgets, entries, imports, reports, rules

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
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
    expose_headers=["Idempotent-Replayed", "X-Request-ID", "Retry-After"],
)


# Conservative headers for an API that also serves its own SPA. The CSP allows the
# Google Fonts stylesheet the frontend uses; everything else is same-origin.
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline'; "  # the tiny inline theme bootstrap in index.html
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' data:; "
        "connect-src 'self'; "
        "frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    ),
}
DOCS_CSP = (  # Swagger UI loads its assets from jsDelivr
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
    "img-src 'self' data: https://fastapi.tiangolo.com; frame-ancestors 'none'"
)
access_log = logging.getLogger("ledgerwise.access")


@app.middleware("http")
async def request_context(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    """Request ID (echoed back, accepted from upstream if sane), timing, security headers."""
    incoming = request.headers.get("x-request-id", "")
    sane = 0 < len(incoming) <= 64 and incoming.isprintable()
    request_id = incoming if sane else uuid.uuid4().hex
    started = time.perf_counter()
    response = await call_next(request)
    elapsed_ms = (time.perf_counter() - started) * 1000
    response.headers["X-Request-ID"] = request_id
    for name, value in SECURITY_HEADERS.items():
        response.headers.setdefault(name, value)
    if request.url.path in ("/docs", "/redoc"):
        response.headers["Content-Security-Policy"] = DOCS_CSP
    if request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https":
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    if request.url.path.startswith("/api/"):
        access_log.info(
            "%s %s %s %.1fms rid=%s",
            request.method,
            request.url.path,
            response.status_code,
            elapsed_ms,
            request_id,
        )
    return response


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
def health(db: DB) -> JSONResponse:
    """Liveness *and* readiness: the deploy platform only routes traffic once the DB answers."""
    try:
        db.execute(text("SELECT 1"))
    except SQLAlchemyError:
        logger.exception("Health check: database unreachable")
        return JSONResponse({"status": "degraded", "database": "unreachable"}, status_code=503)
    return JSONResponse({"status": "ok", "database": "ok"})


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
