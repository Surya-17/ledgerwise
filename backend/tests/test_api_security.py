from fastapi.testclient import TestClient

from app.routers import auth as auth_router
from tests.conftest import register


def test_security_headers_and_request_id(client: TestClient) -> None:
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "database": "ok"}
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["x-frame-options"] == "DENY"
    assert "frame-ancestors 'none'" in r.headers["content-security-policy"]
    assert len(r.headers["x-request-id"]) == 32

    echoed = client.get("/api/health", headers={"X-Request-ID": "trace-abc-123"})
    assert echoed.headers["x-request-id"] == "trace-abc-123"
    junk = client.get("/api/health", headers={"X-Request-ID": "x" * 500})
    assert junk.headers["x-request-id"] != "x" * 500


def _login(client: TestClient, email: str, password: str, ip: str = "198.51.100.9"):
    return client.post(
        "/api/auth/token",
        data={"username": email, "password": password},
        headers={"X-Forwarded-For": ip},
    )


def test_failed_logins_are_limited_per_account(client: TestClient) -> None:
    register(client, email="target@example.com")
    for i in range(auth_router.LOGIN_FAILURES_PER_ACCOUNT):
        # Rotating addresses doesn't help an attacker against one account.
        assert _login(client, "target@example.com", "wrong-guess", f"10.0.0.{i}").status_code == 401
    blocked = _login(client, "target@example.com", "correct-horse-battery")
    assert blocked.status_code == 429
    assert int(blocked.headers["retry-after"]) > 0


def test_failed_logins_are_limited_per_address(client: TestClient) -> None:
    for i in range(auth_router.LOGIN_FAILURES_PER_IP):
        assert _login(client, f"nobody{i}@example.com", "x", "203.0.113.50").status_code == 401
    assert _login(client, "someone@example.com", "x", "203.0.113.50").status_code == 429
    assert _login(client, "someone@example.com", "x", "203.0.113.51").status_code == 401


def test_successful_login_clears_the_account_counter(client: TestClient) -> None:
    register(client, email="me@example.com")
    for _ in range(auth_router.LOGIN_FAILURES_PER_ACCOUNT - 1):
        _login(client, "me@example.com", "typo")
    assert _login(client, "me@example.com", "correct-horse-battery").status_code == 200
    for _ in range(auth_router.LOGIN_FAILURES_PER_ACCOUNT - 1):
        assert _login(client, "me@example.com", "typo").status_code == 401
