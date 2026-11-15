"""All agent routes, grouped under /api/agent."""

from typing import Any

import anthropic
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.agent.agent import build_scene_agent
from app.agent.tools import SceneSession

router = APIRouter(prefix="/api/agent", tags=["Agent"])


class SceneRequest(BaseModel):
    description: str = Field(min_length=1, max_length=4000, description="What the view shows now.")
    goal: str | None = Field(default=None, max_length=500, description="What the shopper wants.")


class SceneDecision(BaseModel):
    actions: list[dict[str, Any]]
    """Tool calls the agent made, in order (speak, turn, move_forward, stop)."""
    reply: str
    """The agent's final text. Reasoning blocks are not included."""


def _agent(request: Request):
    app = request.app
    if getattr(app.state, "scene_agent", None) is None:
        settings = app.state.settings
        if not settings.agent_configured:
            raise HTTPException(status_code=503, detail="Agent not configured: set ANTHROPIC_API_KEY")
        app.state.scene_agent = build_scene_agent(settings)
    return app.state.scene_agent


def _text(message: Any) -> str:
    content = getattr(message, "content", "")
    if isinstance(content, str):
        return content.strip()
    return "\n".join(
        b["text"].strip() for b in content if isinstance(b, dict) and b.get("type") == "text"
    ).strip()


@router.get("/status")
def status(request: Request) -> dict[str, Any]:
    """Whether the agent can run. Never returns the key."""
    settings = request.app.state.settings
    return {"configured": settings.agent_configured, "model": settings.agent_model}


@router.post("/scene", response_model=SceneDecision)
def decide(body: SceneRequest, request: Request) -> SceneDecision:
    """Give the agent one scene description; get back the actions it chose."""
    agent = _agent(request)
    prompt = f"Scene: {body.description}"
    if body.goal:
        prompt += f"\nShopper's goal: {body.goal}"
    session = SceneSession()
    try:
        result = agent.invoke({"messages": [{"role": "user", "content": prompt}]}, context=session)
    except anthropic.APIError as error:  # detail stays generic: no provider response body
        raise HTTPException(
            status_code=502, detail=f"Model provider error: {type(error).__name__}"
        ) from None
    return SceneDecision(actions=session.actions, reply=_text(result["messages"][-1]))
