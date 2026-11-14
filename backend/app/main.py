from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import Settings
from app.database import DatabaseUnavailable, ReadDatabase, get_database
from app.drawings import router as drawing_router
from app.routes import router


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings if settings is not None else Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.database = None
        if settings.database_configured:
            key = settings.supabase_anon_key.get_secret_value().strip()
            headers = {"apikey": key, "Accept": "application/json"}
            # Legacy anon keys are JWTs. Publishable keys belong only in apikey.
            if not key.startswith("sb_publishable_"):
                headers["Authorization"] = f"Bearer {key}"
            with httpx.Client(
                base_url=f"{settings.supabase_url.strip().rstrip('/')}/rest/v1/",
                headers=headers,
                timeout=10.0,
                follow_redirects=False,
            ) as client:
                app.state.database = ReadDatabase(client)
                try:
                    yield
                finally:
                    app.state.database = None
        else:
            yield

    app = FastAPI(
        title="StoreGuide API",
        version="0.1.0",
        description=(
            "Public database reads and scene drawing placeholders. "
            "No authentication or agent endpoints."
        ),
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

    @app.exception_handler(DatabaseUnavailable)
    async def database_error(_request: Request, _error: DatabaseUnavailable):
        return JSONResponse(status_code=503, content={"detail": "Database read unavailable"})

    @app.get("/health", tags=["Health"])
    def health() -> dict[str, str]:
        """Process liveness; this does not contact Supabase."""
        return {"status": "ok"}

    @app.get("/health/ready", tags=["Health"])
    def ready(request: Request) -> dict[str, str]:
        """Readiness includes a small public Supabase read."""
        get_database(request).select("stores", "id")
        return {"status": "ready", "database": "ok"}

    app.include_router(router)
    app.include_router(drawing_router)
    return app


app = create_app()
