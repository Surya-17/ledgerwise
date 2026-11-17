from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://postgres:postgres@localhost:5432/ledgerwise"
    jwt_secret: str = "dev-only-insecure-secret-change-me"
    jwt_algorithm: str = "HS256"
    access_token_minutes: int = 60
    cors_origins: list[str] = ["http://localhost:5173"]
    # Built React app to serve from the API (single-service deploys). Unset in development.
    static_dir: str | None = None
    # Optional AI for "describe a bill" on the split form. Without a key, a built-in
    # rule-based parser is used. Default provider: Google Gemini (free tier key from
    # https://aistudio.google.com/apikey).
    ai_api_key: str | None = None
    ai_model: str = "gemini-flash-latest"
    ai_base_url: str = "https://generativelanguage.googleapis.com/v1beta"
    ai_timeout_seconds: float = 12.0

    @field_validator("database_url")
    @classmethod
    def _use_psycopg3(cls, url: str) -> str:
        # Hosts (Render, Neon, Heroku) hand out postgres:// URLs; SQLAlchemy needs the driver.
        for prefix in ("postgres://", "postgresql://"):
            if url.startswith(prefix):
                return "postgresql+psycopg://" + url.removeprefix(prefix)
        return url


settings = Settings()
