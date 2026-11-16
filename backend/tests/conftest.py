"""Test setup.

By default tests run against in-memory SQLite (fast, nothing to install).
Set TEST_DATABASE_URL to a PostgreSQL database to run the full suite, including
the trigger tests, against the real thing. CI does this. The database must be
empty and disposable: its tables are truncated between tests.
"""

import os
import uuid
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, event, text
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import Base, get_db
from app.main import app
from app.models import User
from app.services import ledger

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL", "sqlite://")
IS_POSTGRES = TEST_DATABASE_URL.startswith("postgresql")


def _make_engine() -> Engine:
    if not IS_POSTGRES:
        engine = create_engine(
            "sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False}
        )

        @event.listens_for(engine, "connect")
        def _enable_fks(dbapi_conn, _record):  # SQLite ignores FKs unless asked
            dbapi_conn.execute("PRAGMA foreign_keys=ON")

        Base.metadata.create_all(engine)
        return engine

    # PostgreSQL: build the schema with the real migrations so triggers exist.
    from alembic.config import Config

    from alembic import command

    cfg = Config("alembic.ini")
    cfg.set_main_option("sqlalchemy.url", TEST_DATABASE_URL.replace("%", "%%"))
    command.upgrade(cfg, "head")
    return create_engine(TEST_DATABASE_URL)


@pytest.fixture(scope="session")
def engine() -> Iterator[Engine]:
    eng = _make_engine()
    yield eng
    eng.dispose()


@pytest.fixture(autouse=True)
def _clean_tables(engine: Engine) -> None:
    with engine.begin() as conn:
        if IS_POSTGRES:
            # TRUNCATE doesn't fire the row-level append-only triggers.
            names = ", ".join(t.name for t in Base.metadata.sorted_tables)
            conn.execute(text(f"TRUNCATE {names} CASCADE"))
        else:
            for table in reversed(Base.metadata.sorted_tables):
                conn.execute(table.delete())


@pytest.fixture
def session_factory(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


@pytest.fixture
def db(session_factory: sessionmaker[Session]) -> Iterator[Session]:
    session = session_factory()
    yield session
    session.close()


@pytest.fixture
def client(session_factory: sessionmaker[Session]) -> Iterator[TestClient]:
    # A fresh session per request, exactly like production.
    def _get_db() -> Iterator[Session]:
        session = session_factory()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = _get_db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def register(client: TestClient, email: str | None = None, currency: str = "USD") -> dict:
    """Create a user and return auth headers for them."""
    email = email or f"user-{uuid.uuid4().hex[:8]}@example.com"
    password = "correct-horse-battery"
    r = client.post(
        "/api/auth/register",
        json={"email": email, "password": password, "base_currency": currency},
    )
    assert r.status_code == 201, r.text
    r = client.post("/api/auth/token", data={"username": email, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture
def auth(client: TestClient) -> dict:
    return register(client)


def accounts_by_name(client: TestClient, headers: dict) -> dict[str, dict]:
    r = client.get("/api/accounts", headers=headers)
    assert r.status_code == 200, r.text
    return {a["name"]: a for a in r.json()}


def make_user(db: Session, currency: str = "USD") -> User:
    """Service-level user without bcrypt (fast, for property tests)."""
    user = User(email=f"{uuid.uuid4().hex}@example.com", password_hash="x", base_currency=currency)
    db.add(user)
    db.flush()
    ledger.create_default_accounts(db, user)
    return user
