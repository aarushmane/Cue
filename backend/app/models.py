from datetime import datetime
from typing import Generic, Literal, TypeVar

from pydantic import BaseModel, Field

T = TypeVar("T")


class Page(BaseModel, Generic[T]):
    items: list[T]
    limit: int
    offset: int


class Pagination(BaseModel):
    limit: int = Field(default=50, ge=1, le=200)
    offset: int = Field(default=0, ge=0)


class Store(BaseModel):
    id: str
    name: str
    address: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    width_m: float
    height_m: float
    floor_plan_url: str | None = None
    costar_property_id: str | None = None
    matterport_model_id: str | None = None
    vexcel_parcel_ref: str | None = None
    created_at: datetime


class Property(BaseModel):
    id: str
    property_id: str
    matterport_model_id: str
    name: str
    address: str | None = None
    created_at: datetime


class StoreMap(BaseModel):
    id: str
    store_id: str
    version: int
    status: Literal["PUBLISHED"]
    created_at: datetime
    published_at: datetime | None = None


class Node(BaseModel):
    id: str
    map_id: str
    x: float
    y: float
    kind: str
    label: str
    facing_deg: float | None = None
    source: str
    sweep_id: str | None = None


class Edge(BaseModel):
    id: str
    map_id: str
    from_node: str
    to_node: str
    weight: float


class Shelf(BaseModel):
    id: str
    map_id: str
    aisle: str
    section: str
    anchor_node: str
    x: float
    y: float
    w: float
    h: float


class Product(BaseModel):
    id: str
    store_id: str
    name: str
    brand: str | None = None
    variant: str | None = None
    size: str | None = None
    barcode: str | None = None
    aliases: list[str]
    category: str | None = None
    created_at: datetime


class ProductLocation(BaseModel):
    id: str
    product_id: str
    shelf_id: str
    level: str | None = None
    status: Literal["PUBLISHED"]
    verified_at: datetime
    last_seen_at: datetime | None = None
    miss_count: int
    created_at: datetime
