import uuid
from typing import Any

from sqlalchemy.orm import Session

from app.models import AuditEvent


def record(
    db: Session,
    user_id: uuid.UUID,
    action: str,
    entity_type: str,
    entity_id: uuid.UUID | str,
    details: dict[str, Any] | None = None,
) -> None:
    """Append an audit event in the same transaction as the change it describes.

    Because it shares the transaction, an audit row exists if and only if the
    change was committed.
    """
    db.add(
        AuditEvent(
            user_id=user_id,
            action=action,
            entity_type=entity_type,
            entity_id=str(entity_id),
            details=details or {},
        )
    )
