from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import Settings
from app.drawings import router as drawing_router
from app.voice import router as voice_router


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings if settings is not None else Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.settings = settings
        async with httpx.AsyncClient(timeout=45, follow_redirects=False) as client:
            app.state.voice_http = client
            yield

    app = FastAPI(
        title="StoreGuide API",
        version="0.1.0",
        description=("Cancellable voice WebSocket and scene drawing placeholders."),
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            origin.strip() for origin in settings.cors_origins.split(",") if origin.strip()
        ],
        allow_credentials=False,
        allow_methods=["GET"],
    )

    @app.get("/health", tags=["Health"])
    def health() -> dict[str, str]:
        """Process liveness without external requests."""
        return {"status": "ok", "service": "storeguide"}

    @app.get("/health/ready", tags=["Health"])
    def ready() -> dict[str, str]:
        """Report local voice configuration without contacting the provider."""
        voice = (
            "configured"
            if settings.elevenlabs_api_key.get_secret_value().strip()
            else "not_configured"
        )
        return {"status": "ready", "voice": voice}

    app.include_router(drawing_router)
    app.include_router(voice_router)
    return app


app = create_app()
