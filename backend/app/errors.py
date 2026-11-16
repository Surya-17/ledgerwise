from typing import Any


class DomainError(Exception):
    """An error the client caused. Converted to a JSON response by app.main."""

    status_code = 400

    def __init__(self, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.extra = extra


class LedgerError(DomainError):
    status_code = 422


class NotFoundError(DomainError):
    status_code = 404


class ConflictError(DomainError):
    status_code = 409
