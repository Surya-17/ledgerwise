import uuid
from typing import Annotated

from fastapi import APIRouter, Form, HTTPException, UploadFile
from sqlalchemy import select

from app.deps import DB, CurrentUser
from app.models import ImportBatch
from app.schemas import ImportOut
from app.services import imports

router = APIRouter(prefix="/imports", tags=["imports"])


@router.post("", response_model=ImportOut, status_code=201)
def upload_statement(
    db: DB,
    user: CurrentUser,
    file: UploadFile,
    account_id: Annotated[uuid.UUID, Form()],
    date_format: Annotated[str, Form(max_length=32)] = "%Y-%m-%d",
    date_column: Annotated[str, Form(max_length=64)] = "date",
    description_column: Annotated[str, Form(max_length=64)] = "description",
    amount_column: Annotated[str, Form(max_length=64)] = "amount",
    invert_amounts: Annotated[bool, Form()] = False,
) -> ImportBatch:
    """Import a CSV statement. Safe to repeat: rows already in the ledger are skipped."""
    content = file.file.read(imports.MAX_FILE_BYTES + 1)
    if len(content) > imports.MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail="File is larger than 5 MB")
    batch = imports.import_csv(
        db,
        user,
        account_id=account_id,
        filename=file.filename or "statement.csv",
        content=content,
        columns=imports.CsvColumns(date_column, description_column, amount_column),
        date_format=date_format,
        invert_amounts=invert_amounts,
    )
    db.commit()
    return batch


@router.get("", response_model=list[ImportOut])
def list_imports(db: DB, user: CurrentUser) -> list[ImportBatch]:
    return list(
        db.scalars(
            select(ImportBatch)
            .where(ImportBatch.user_id == user.id)
            .order_by(ImportBatch.created_at.desc())
            .limit(100)
        )
    )
