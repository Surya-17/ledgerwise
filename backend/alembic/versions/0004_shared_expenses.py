"""Friends, groups and shared (split) expenses.

Revision ID: 0004
Revises: 0003
"""

import sqlalchemy as sa

from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("accounts", sa.Column("kind", sa.String(16), nullable=True))
    op.create_table(
        "friend_groups",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "name"),
    )
    op.create_index("ix_friend_groups_user_id", "friend_groups", ["user_id"])
    op.create_table(
        "friend_group_members",
        sa.Column(
            "group_id",
            sa.Uuid(),
            sa.ForeignKey("friend_groups.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("account_id", sa.Uuid(), sa.ForeignKey("accounts.id"), primary_key=True),
        sa.Column("position", sa.Integer(), nullable=False),
    )
    op.create_table(
        "shared_entries",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column(
            "entry_id", sa.Uuid(), sa.ForeignKey("journal_entries.id"), nullable=False, unique=True
        ),
        sa.Column("group_id", sa.Uuid(), sa.ForeignKey("friend_groups.id", ondelete="SET NULL")),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("payer_account_id", sa.Uuid(), sa.ForeignKey("accounts.id")),
        sa.Column("total_minor", sa.BigInteger(), nullable=False),
        sa.Column("currency", sa.String(3), nullable=False),
        sa.Column("method", sa.String(16)),
        sa.Column("shares", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_shared_entries_user_id_group_id", "shared_entries", ["user_id", "group_id"])


def downgrade() -> None:
    op.drop_table("shared_entries")
    op.drop_table("friend_group_members")
    op.drop_index("ix_friend_groups_user_id", "friend_groups")
    op.drop_table("friend_groups")
    op.drop_column("accounts", "kind")
