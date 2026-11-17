import secrets
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import select

from app import audit
from app.deps import DB, CurrentUser
from app.errors import ConflictError
from app.models import User
from app.ratelimit import SlidingWindowLimiter, client_ip
from app.schemas import Token, UserCreate, UserOut
from app.security import create_access_token, hash_password, verify_password
from app.services import ledger
from app.services.demo import populate_demo_data

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=UserOut, status_code=201)
def register(body: UserCreate, db: DB) -> User:
    email = body.email.lower()
    if db.scalar(select(User.id).where(User.email == email)):
        raise ConflictError("An account with this email already exists")
    user = User(
        email=email, password_hash=hash_password(body.password), base_currency=body.base_currency
    )
    db.add(user)
    db.flush()
    ledger.create_default_accounts(db, user)
    audit.record(db, user.id, "user.registered", "user", user.id)
    db.commit()
    return user


# Brute-force protection: failed logins are limited per account (any address) and per
# address (any account). Only failures count, so normal use never trips it. The per-account
# limit means an attacker can temporarily lock a victim out of password login; that's the
# usual trade-off, and the window is short.
LOGIN_FAILURES_PER_ACCOUNT = 10
LOGIN_FAILURES_PER_IP = 30
LOGIN_WINDOW_SECONDS = 15 * 60
_login_message = "Too many failed sign-in attempts; try again in a few minutes"
login_account_limiter = SlidingWindowLimiter(
    LOGIN_FAILURES_PER_ACCOUNT, LOGIN_WINDOW_SECONDS, _login_message
)
login_ip_limiter = SlidingWindowLimiter(LOGIN_FAILURES_PER_IP, LOGIN_WINDOW_SECONDS, _login_message)


@router.post("/token", response_model=Token)
def login(request: Request, form: Annotated[OAuth2PasswordRequestForm, Depends()], db: DB) -> Token:
    """OAuth2 password flow. `username` is the email address."""
    email = form.username.lower()
    ip = client_ip(request)
    login_account_limiter.check(email)
    login_ip_limiter.check(ip)

    user = db.scalar(select(User).where(User.email == email))
    if not verify_password(form.password, user.password_hash if user else None):
        login_account_limiter.hit(email)
        login_ip_limiter.hit(ip)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    assert user is not None
    login_account_limiter.reset(email)
    return Token(access_token=create_access_token(user.id))


@router.get("/me", response_model=UserOut)
def me(user: CurrentUser) -> User:
    return user


# --- Demo sandboxes ---------------------------------------------------------------------
# Each visitor gets a private, freshly seeded user. A shared demo login would not work:
# the ledger is append-only, so one visitor's edits would be every visitor's history.

DEMO_EMAIL_DOMAIN = "demo.ledgerwise.app"
DEMO_LIMIT_PER_HOUR = 10
demo_limiter = SlidingWindowLimiter(
    DEMO_LIMIT_PER_HOUR, 3600, "Too many demo sandboxes from this address; try again later"
)


@router.post("/demo", response_model=Token, status_code=201)
def create_demo(request: Request, db: DB) -> Token:
    """Create a private sandbox user with six months of demo data and log straight in."""
    demo_limiter.check_and_hit(client_ip(request))
    user = User(
        email=f"demo-{secrets.token_hex(6)}@{DEMO_EMAIL_DOMAIN}",
        # Random, never revealed: the sandbox is reachable only through the returned token.
        password_hash=hash_password(secrets.token_urlsafe(24)),
        base_currency="USD",
    )
    db.add(user)
    db.flush()
    ledger.create_default_accounts(db, user)
    audit.record(db, user.id, "user.registered", "user", user.id, {"demo": True})
    populate_demo_data(db, user)
    db.commit()
    return Token(access_token=create_access_token(user.id))
