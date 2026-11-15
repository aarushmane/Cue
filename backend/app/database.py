from typing import Any

import httpx
from fastapi import HTTPException, Request

from app.models import Pagination

# Explicit public fields: no staff identities, review evidence, or audit payloads.
STORE_COLUMNS = (
    "id,name,address,latitude,longitude,width_m,height_m,floor_plan_url,"
    "costar_property_id,matterport_model_id,vexcel_parcel_ref,created_at"
)
PROPERTY_COLUMNS = "id,property_id:costar_property_id,matterport_model_id,name,address,created_at"
MAP_COLUMNS = "id,store_id,version,status,created_at,published_at"
NODE_COLUMNS = "id,map_id,x,y,kind,label,facing_deg,source,sweep_id"
EDGE_COLUMNS = "id,map_id,from_node,to_node,weight"
SHELF_COLUMNS = "id,map_id,aisle,section,anchor_node,x,y,w,h"
PRODUCT_COLUMNS = "id,store_id,name,brand,variant,size,barcode,aliases,category,created_at"
LOCATION_COLUMNS = (
    "id,product_id,shelf_id,level,status,verified_at,last_seen_at,miss_count,created_at"
)


class DatabaseUnavailable(Exception):
    pass


class ReadDatabase:
    """Only issues GET requests to Supabase's PostgREST API, using its public key."""

    def __init__(self, client: httpx.Client):
        self.client = client

    def select(
        self,
        table: str,
        columns: str,
        *,
        filters: dict[str, str] | None = None,
        order: str = "id.asc",
        limit: int = 1,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        params = {
            "select": columns,
            "order": order,
            "limit": str(limit),
            "offset": str(offset),
            **(filters or {}),
        }
        try:
            response = self.client.get(table, params=params)
            response.raise_for_status()
            rows = response.json()
            if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
                raise ValueError("Expected database rows")
            return rows
        except (httpx.HTTPError, ValueError) as error:
            # Never return upstream responses, URLs, or credentials to callers.
            raise DatabaseUnavailable from error

    def one(self, table: str, columns: str, *, filters: dict[str, str], label: str):
        rows = self.select(table, columns, filters=filters)
        if not rows:
            raise HTTPException(status_code=404, detail=f"{label} not found")
        return rows[0]

    def page(
        self,
        table: str,
        columns: str,
        pagination: Pagination,
        *,
        filters: dict[str, str] | None = None,
        order: str = "id.asc",
    ):
        return {
            "items": self.select(
                table,
                columns,
                filters=filters,
                order=order,
                limit=pagination.limit,
                offset=pagination.offset,
            ),
            "limit": pagination.limit,
            "offset": pagination.offset,
        }


def get_database(request: Request) -> ReadDatabase:
    database = request.app.state.database
    if database is None:
        raise HTTPException(status_code=503, detail="Supabase public read access is not configured")
    return database
