from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    supabase_url: str
    supabase_service_role_key: str
    frontend_origin: str = "http://localhost:3000"
    local_mode: bool = False

    model_config = {"env_file": ".env"}


settings = Settings()
