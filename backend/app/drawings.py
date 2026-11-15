from fastapi import APIRouter, HTTPException, WebSocket

router = APIRouter()


@router.get("/api/scenes/{scene_id}/draw/demo", tags=["Scene drawing"])
def get_demo_drawing(scene_id: str):
    # TODO: Return scene drawing data.
    raise HTTPException(status_code=501, detail="Scene drawing is not implemented yet")


@router.websocket("/ws/scenes/{scene_id}/draw")
async def scene_drawing(websocket: WebSocket, scene_id: str):
    # TODO: Stream drawing commands to the scene.
    await websocket.accept()
    await websocket.send_json({"status": "not_implemented", "scene_id": scene_id})
    await websocket.close()
