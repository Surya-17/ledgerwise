"""ledger integrity guards (PostgreSQL)

Defense in depth: the service layer already validates entries, but these
triggers make the invariants hold even for code paths that bypass it (a bad
migration, a manual SQL session, a future bug).

  1. Balanced entries — a DEFERRED constraint trigger checks, at COMMIT time,
     that every touched entry's lines sum to zero per currency and that the entry
     has at least two lines. Deferral lets an entry's lines be inserted one by one
     inside a transaction.
  2. Append-only ledger — UPDATE and DELETE on journal entries, journal lines and
     the audit log raise an error. Corrections are made with reversing entries.

Revision ID: 0002
Revises: 0001
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

APPEND_ONLY_TABLES = ("journal_entries", "journal_lines", "audit_log")


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return  # SQLite (used for fast local tests) relies on the service-layer checks.

    op.execute(
        """
        CREATE FUNCTION ledger_assert_entry_balanced() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            IF (SELECT COUNT(*) FROM journal_lines WHERE entry_id = NEW.entry_id) < 2 THEN
                RAISE EXCEPTION 'journal entry % has fewer than two lines', NEW.entry_id
                    USING ERRCODE = 'check_violation';
            END IF;
            IF EXISTS (
                SELECT 1 FROM journal_lines
                WHERE entry_id = NEW.entry_id
                GROUP BY currency
                HAVING SUM(amount_minor) <> 0
            ) THEN
                RAISE EXCEPTION 'journal entry % does not balance', NEW.entry_id
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NULL;
        END;
        $$;
        """
    )
    op.execute(
        """
        CREATE CONSTRAINT TRIGGER journal_lines_balanced
        AFTER INSERT ON journal_lines
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION ledger_assert_entry_balanced();
        """
    )
    op.execute(
        """
        CREATE FUNCTION ledger_forbid_mutation() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION '% is append-only; post a reversing entry instead', TG_TABLE_NAME
                USING ERRCODE = 'restrict_violation';
        END;
        $$;
        """
    )
    for table in APPEND_ONLY_TABLES:
        op.execute(
            f"""
            CREATE TRIGGER {table}_append_only
            BEFORE UPDATE OR DELETE ON {table}
            FOR EACH ROW EXECUTE FUNCTION ledger_forbid_mutation();
            """
        )


def downgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    for table in APPEND_ONLY_TABLES:
        op.execute(f"DROP TRIGGER IF EXISTS {table}_append_only ON {table}")
    op.execute("DROP FUNCTION IF EXISTS ledger_forbid_mutation()")
    op.execute("DROP TRIGGER IF EXISTS journal_lines_balanced ON journal_lines")
    op.execute("DROP FUNCTION IF EXISTS ledger_assert_entry_balanced()")
