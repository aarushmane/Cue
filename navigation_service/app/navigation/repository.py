"""Read-only lookup of navigation data by Matterport model ID.

Data is loaded once at startup and never mutated, so concurrent users can't affect
each other. Every lookup is scoped by model ID; sweeps from one model are never
visible from another.
"""

from __future__ import annotations

from types import MappingProxyType
from typing import Iterable, Mapping

from .models import ModelNavigationData, NavigationDataError
from .sample_data import build_sample_model


class NavigationRepository:
    def __init__(self, models: Iterable[ModelNavigationData]) -> None:
        by_id: dict[str, ModelNavigationData] = {}
        for model in models:
            if model.model_id in by_id:
                raise NavigationDataError(f"Model {model.model_id!r} was loaded twice")
            by_id[model.model_id] = model
        self._models: Mapping[str, ModelNavigationData] = MappingProxyType(by_id)

    def get(self, model_id: str) -> ModelNavigationData | None:
        return self._models.get(model_id)

    def model_ids(self) -> list[str]:
        return sorted(self._models)


def sample_repository() -> NavigationRepository:
    """Repository containing only the clearly labeled sample model."""
    return NavigationRepository([build_sample_model()])
