"""Shared bills: notes, itemized details, edits and recurring bills.

Revision ID: 0005
Revises: 0004
"""

import sqlalchemy as sa

from alembic import op

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "shared_recurring",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("description", sa.String(500), nullable=False),
        sa.Column("template", sa.JSON(), nullable=False),
        sa.Column("cadence", sa.String(16), nullable=False),
        sa.Column("anchor_day", sa.Integer(), nullable=False),
        sa.Column("next_on", sa.Date(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_shared_recurring_user_id", "shared_recurring", ["user_id"])
    with op.batch_alter_table("shared_entries") as t:
        t.add_column(sa.Column("notes", sa.Text(), nullable=True))
        t.add_column(sa.Column("details", sa.JSON(), nullable=True))
        t.add_column(sa.Column("edited_from_id", sa.Uuid(), nullable=True))
        t.add_column(sa.Column("recurring_id", sa.Uuid(), nullable=True))
        t.add_column(sa.Column("occurrence_on", sa.Date(), nullable=True))
        t.create_foreign_key(
            "fk_shared_entries_edited_from_id_shared_entries",
            "shared_entries",
            ["edited_from_id"],
            ["id"],
        )
        t.create_foreign_key(
            "fk_shared_entries_recurring_id_shared_recurring",
            "shared_recurring",
            ["recurring_id"],
            ["id"],
            ondelete="SET NULL",
        )
        t.create_unique_constraint(
            "uq_shared_entries_recurring_id_occurrence_on", ["recurring_id", "occurrence_on"]
        )


def downgrade() -> None:
    with op.batch_alter_table("shared_entries") as t:
        t.drop_constraint("uq_shared_entries_recurring_id_occurrence_on", type_="unique")
        t.drop_constraint("fk_shared_entries_recurring_id_shared_recurring", type_="foreignkey")
        t.drop_constraint("fk_shared_entries_edited_from_id_shared_entries", type_="foreignkey")
        for col in ("occurrence_on", "recurring_id", "edited_from_id", "details", "notes"):
            t.drop_column(col)
    op.drop_index("ix_shared_recurring_user_id", "shared_recurring")
    op.drop_table("shared_recurring")
