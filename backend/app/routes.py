from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query

from app.database import (
    EDGE_COLUMNS,
    LOCATION_COLUMNS,
    MAP_COLUMNS,
    NODE_COLUMNS,
    PRODUCT_COLUMNS,
    PROPERTY_COLUMNS,
    SHELF_COLUMNS,
    STORE_COLUMNS,
    ReadDatabase,
    get_database,
)
from app.models import (
    Edge,
    Node,
    Page,
    Pagination,
    Product,
    ProductLocation,
    Property,
    Shelf,
    Store,
    StoreMap,
)

router = APIRouter(prefix="/api", responses={503: {"description": "Database unavailable"}})
Database = Annotated[ReadDatabase, Depends(get_database)]
Paging = Annotated[Pagination, Query()]
Search = Annotated[str | None, Query(min_length=1, max_length=100)]


def require_store(db: ReadDatabase, store_id: str):
    return db.one("stores", "id", filters={"id": f"eq.{store_id}"}, label="Store")


def require_map(db: ReadDatabase, map_id: str):
    return db.one(
        "store_maps",
        MAP_COLUMNS,
        filters={"id": f"eq.{map_id}", "status": "eq.PUBLISHED"},
        label="Published map",
    )


@router.get("/stores", response_model=Page[Store], tags=["Stores"])
def list_stores(db: Database, pagination: Paging, q: Search = None):
    """List public stores. Optional q searches store names (case insensitive)."""
    filters = {"name": f"ilike.*{q}*"} if q else None
    return db.page("stores", STORE_COLUMNS, pagination, filters=filters, order="name.asc,id.asc")


@router.get("/stores/{store_id}", response_model=Store, tags=["Stores"])
def get_store(store_id: str, db: Database):
    return db.one("stores", STORE_COLUMNS, filters={"id": f"eq.{store_id}"}, label="Store")


@router.get("/properties/{property_id}", response_model=Property, tags=["Properties"])
def get_property(property_id: Annotated[str, Path(pattern=r"^\d+$")], db: Database):
    """Find the newest saved Matterport mapping for a CoStar property ID."""
    rows = db.select(
        "stores",
        PROPERTY_COLUMNS,
        filters={"costar_property_id": f"eq.{property_id}", "matterport_model_id": "not.is.null"},
        order="created_at.desc,id.asc",
    )
    if not rows:
        raise HTTPException(status_code=404, detail="Property scan mapping not found")
    return rows[0]


@router.get("/stores/{store_id}/maps", response_model=Page[StoreMap], tags=["Maps"])
def list_maps(store_id: str, db: Database, pagination: Paging):
    require_store(db, store_id)
    return db.page(
        "store_maps",
        MAP_COLUMNS,
        pagination,
        filters={"store_id": f"eq.{store_id}", "status": "eq.PUBLISHED"},
        order="version.desc,id.asc",
    )


@router.get("/maps/{map_id}", response_model=StoreMap, tags=["Maps"])
def get_map(map_id: str, db: Database):
    return require_map(db, map_id)


@router.get("/maps/{map_id}/nodes", response_model=Page[Node], tags=["Maps"])
def list_nodes(map_id: str, db: Database, pagination: Paging):
    require_map(db, map_id)
    return db.page("nodes", NODE_COLUMNS, pagination, filters={"map_id": f"eq.{map_id}"})


@router.get("/maps/{map_id}/edges", response_model=Page[Edge], tags=["Maps"])
def list_edges(map_id: str, db: Database, pagination: Paging):
    require_map(db, map_id)
    return db.page("edges", EDGE_COLUMNS, pagination, filters={"map_id": f"eq.{map_id}"})


@router.get("/maps/{map_id}/shelves", response_model=Page[Shelf], tags=["Maps"])
def list_shelves(map_id: str, db: Database, pagination: Paging):
    require_map(db, map_id)
    return db.page("shelves", SHELF_COLUMNS, pagination, filters={"map_id": f"eq.{map_id}"})


@router.get("/stores/{store_id}/products", response_model=Page[Product], tags=["Products"])
def list_products(store_id: str, db: Database, pagination: Paging, q: Search = None):
    """List products visible through Supabase's public row policies. q searches names."""
    require_store(db, store_id)
    filters = {"store_id": f"eq.{store_id}"}
    if q:
        filters["name"] = f"ilike.*{q}*"
    return db.page(
        "products", PRODUCT_COLUMNS, pagination, filters=filters, order="name.asc,id.asc"
    )


@router.get("/products/{product_id}", response_model=Product, tags=["Products"])
def get_product(product_id: str, db: Database):
    return db.one("products", PRODUCT_COLUMNS, filters={"id": f"eq.{product_id}"}, label="Product")


@router.get("/products/{product_id}/location", response_model=ProductLocation, tags=["Products"])
def get_product_location(product_id: str, db: Database):
    db.one("products", "id", filters={"id": f"eq.{product_id}"}, label="Product")
    return db.one(
        "product_locations",
        LOCATION_COLUMNS,
        filters={"product_id": f"eq.{product_id}", "status": "eq.PUBLISHED"},
        label="Published product location",
    )
