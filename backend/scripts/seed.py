"""Create a demo user with six months of realistic, deterministic activity.

python -m scripts.seed               # demo@ledgerwise.dev / demo-password
python -m scripts.seed --email you@example.com --password something-long
"""

import argparse

from sqlalchemy import select

from app import audit
from app.db import SessionLocal
from app.models import User
from app.security import hash_password
from app.services import ledger
from app.services.demo import populate_demo_data


def seed(email: str, password: str) -> None:
    with SessionLocal() as db:
        if db.scalar(select(User.id).where(User.email == email)):
            print(f"{email} already exists; nothing to do (the ledger is append-only).")
            return

        user = User(email=email, password_hash=hash_password(password), base_currency="USD")
        db.add(user)
        db.flush()
        ledger.create_default_accounts(db, user)
        audit.record(db, user.id, "user.registered", "user", user.id)
        populate_demo_data(db, user)
        db.commit()
        print(f"Seeded {email} (password: {password}).")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--email", default="demo@ledgerwise.dev")
    parser.add_argument("--password", default="demo-password")
    args = parser.parse_args()
    seed(args.email.lower(), args.password)
