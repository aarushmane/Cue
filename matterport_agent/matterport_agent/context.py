"""Per-session dependencies for the navigation agent.

The agent object itself holds no navigation data. Each invocation passes a NavigationSession
through LangChain's runtime context (`agent.invoke(..., context=session)`), and the tools read it
from `runtime.context`. Two users talking to the same agent therefore never share sweep data,
arrow settings, or any mutable state.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .arrows import ArrowConfig
from .models import ModelNavigationData


@dataclass(frozen=True)
class NavigationSession:
    model_data: ModelNavigationData
    """Sweeps and destinations for exactly one Matterport model."""
    arrow_config: ArrowConfig = field(default_factory=ArrowConfig)
