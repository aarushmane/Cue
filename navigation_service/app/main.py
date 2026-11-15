"""Small FastAPI app exposing the Matterport sweep navigation service.

Run locally (from backend/):  uvicorn app.main:app --reload --port 8000
"""

from __future__ import annotations

from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

from app.navigation import service
from app.navigation.models import ModelNavigationData
from app.navigation.repository import NavigationRepository, sample_repository


class ResolveRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class PlanRequest(BaseModel):
    start_sweep_id: str = Field(min_length=1, max_length=200)
    destination_sweep_id: str = Field(min_length=1, max_length=200)


def create_app(repository: NavigationRepository | None = None) -> FastAPI:
    app = FastAPI(title="StoreGuide navigation")
    # Read-only after startup; safe to share across requests.
    app.state.navigation = repository or sample_repository()

    def model_data(model_id: str, request: Request) -> ModelNavigationData:
        data = request.app.state.navigation.get(model_id)
        if data is None:
            raise HTTPException(status_code=404, detail=f"Unknown Matterport model {model_id!r}")
        return data

    @app.get("/health")
    def health() -> dict[str, Any]:
        return {"ok": True, "models": app.state.navigation.model_ids()}

    @app.get("/models/{model_id}/destinations")
    def destinations(data: ModelNavigationData = Depends(model_data)) -> dict[str, Any]:
        return {
            "model_id": data.model_id,
            "is_sample": data.is_sample,
            "destinations": [{"name": d.name, "sweep_id": d.sweep_id, "aliases": list(d.aliases)} for d in data.destinations],
        }

    @app.post("/models/{model_id}/navigation/resolve")
    def resolve(body: ResolveRequest, data: ModelNavigationData = Depends(model_data)) -> dict[str, Any]:
        return service.resolve_destination(data, body.name)

    @app.post("/models/{model_id}/navigation/plan")
    def plan(body: PlanRequest, data: ModelNavigationData = Depends(model_data)) -> dict[str, Any]:
        return service.plan_navigation(data, body.start_sweep_id, body.destination_sweep_id).to_dict()

    return app


app = create_app()
