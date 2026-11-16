"""Idempotent write requests.

A client sends `Idempotency-Key: <uuid>` with a POST. If the network drops and
the client retries with the same key, it gets the original response back instead
of creating a second transaction.

The stored response is written in the same database transaction as the work
itself, so the two can never disagree. If two identical requests race, the
primary key on (user_id, key) lets exactly one commit; the loser rolls back and
replays the winner's response.
"""

import hashlib
import json
import uuid
from collections.abc import Callable
from typing import Any

from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.errors import DomainError
from app.models import IdempotencyRecord


class IdempotencyMismatch(DomainError):
    status_code = 422


def _request_hash(payload: Any) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode()).hexdigest()


def _replay(record: IdempotencyRecord, request_hash: str) -> JSONResponse:
    if record.request_hash != request_hash:
        raise IdempotencyMismatch("Idempotency-Key was already used with a different request")
    return JSONResponse(
        record.response_body,
        status_code=record.status_code,
        headers={"Idempotent-Replayed": "true"},
    )


def run_idempotent(
    db: Session,
    user_id: uuid.UUID,
    key: str | None,
    request_payload: Any,
    action: Callable[[], dict[str, Any]],
    status_code: int = 201,
) -> JSONResponse:
    """Run `action` (which writes but doesn't commit) at most once per key, then commit."""
    if key is None:
        body = action()
        db.commit()
        return JSONResponse(body, status_code=status_code)

    request_hash = _request_hash(request_payload)
    if existing := db.get(IdempotencyRecord, (user_id, key)):
        return _replay(existing, request_hash)

    body = action()
    db.add(
        IdempotencyRecord(
            user_id=user_id,
            key=key,
            request_hash=request_hash,
            status_code=status_code,
            response_body=body,
        )
    )
    try:
        db.commit()
    except IntegrityError:
        # A concurrent request with the same key committed first.
        db.rollback()
        existing = db.get(IdempotencyRecord, (user_id, key))
        if existing is None:
            raise
        return _replay(existing, request_hash)
    return JSONResponse(body, status_code=status_code)
