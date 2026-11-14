from collections.abc import Iterator

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.database import ReadDatabase
from app.main import create_app

NOW = "2026-11-14T12:00:00Z"
ROWS = {
    "stores": [
        {
            "id": "store-1",
            "name": "Demo",
            "width_m": 30,
            "height_m": 20,
            "created_at": NOW,
            "costar_property_id": "236314",
            "property_id": "236314",
            "matterport_model_id": "Muo5jpq44Xk",
        }
    ],
    "store_maps": [
        {
            "id": "map-1",
            "store_id": "store-1",
            "version": 1,
            "status": "PUBLISHED",
            "created_at": NOW,
        }
    ],
    "nodes": [
        {
            "id": "node-1",
            "map_id": "map-1",
            "x": 0.5,
            "y": 0.5,
            "kind": "entrance",
            "label": "Entrance",
            "source": "manual",
        }
    ],
    "edges": [
        {
            "id": "edge-1",
            "map_id": "map-1",
            "from_node": "node-1",
            "to_node": "node-2",
            "weight": 1,
        }
    ],
    "shelves": [
        {
            "id": "shelf-1",
            "map_id": "map-1",
            "aisle": "A",
            "section": "1",
            "anchor_node": "node-1",
            "x": 0,
            "y": 0,
            "w": 1,
            "h": 1,
        }
    ],
    "products": [
        {
            "id": "product-1",
            "store_id": "store-1",
            "name": "Milk",
            "aliases": [],
            "created_at": NOW,
        }
    ],
    "product_locations": [
        {
            "id": "location-1",
            "product_id": "product-1",
            "shelf_id": "shelf-1",
            "status": "PUBLISHED",
            "verified_at": NOW,
            "created_at": NOW,
            "miss_count": 0,
            "verified_by": "private-user-id",
            "observation_id": "private-observation-id",
        }
    ],
}


def no_database_settings() -> Settings:
    return Settings(_env_file=None, SUPABASE_URL="", SUPABASE_ANON_KEY="")


@pytest.fixture
def api() -> Iterator[tuple[TestClient, list[httpx.Request]]]:
    requests = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.method == "GET"
        return httpx.Response(200, json=ROWS[request.url.path.split("/")[-1]])

    with httpx.Client(
        base_url="https://example.supabase.co/rest/v1/", transport=httpx.MockTransport(respond)
    ) as upstream:
        with TestClient(create_app(no_database_settings())) as client:
            client.app.state.database = ReadDatabase(upstream)
            yield client, requests


@pytest.mark.parametrize(
    "path",
    [
        "/api/stores",
        "/api/stores/store-1",
        "/api/properties/236314",
        "/api/stores/store-1/maps",
        "/api/maps/map-1",
        "/api/maps/map-1/nodes",
        "/api/maps/map-1/edges",
        "/api/maps/map-1/shelves",
        "/api/stores/store-1/products",
        "/api/products/product-1",
        "/api/products/product-1/location",
        "/health/ready",
    ],
)
def test_read_routes(api, path):
    client, requests = api
    response = client.get(path)
    assert response.status_code == 200, response.text
    assert requests


def test_pagination_search_and_store_scope(api):
    client, requests = api
    response = client.get("/api/stores/store-1/products?q=Milk&limit=10&offset=20")
    assert response.status_code == 200
    assert response.json()["limit"] == 10
    assert response.json()["offset"] == 20
    params = requests[-1].url.params
    assert params["store_id"] == "eq.store-1"
    assert params["name"] == "ilike.*Milk*"
    assert params["limit"] == "10"
    assert params["offset"] == "20"
    assert params["order"] == "name.asc,id.asc"


@pytest.mark.parametrize("query", ["limit=0", "limit=201", "offset=-1", "q="])
def test_invalid_pagination_or_search_never_contacts_database(api, query):
    client, requests = api
    assert client.get(f"/api/stores?{query}").status_code == 422
    assert requests == []


@pytest.mark.parametrize("resource", ["nodes", "edges", "shelves"])
def test_map_children_require_published_parent(api, resource):
    client, requests = api
    assert client.get(f"/api/maps/map-1/{resource}").status_code == 200
    assert requests[0].url.params["id"] == "eq.map-1"
    assert requests[0].url.params["status"] == "eq.PUBLISHED"
    assert requests[1].url.params["map_id"] == "eq.map-1"


def test_only_published_locations_and_no_private_fields(api):
    client, requests = api
    response = client.get("/api/products/product-1/location")
    assert response.status_code == 200
    assert requests[-1].url.params["status"] == "eq.PUBLISHED"
    assert "verified_by" not in requests[-1].url.params["select"]
    assert "observation_id" not in requests[-1].url.params["select"]
    assert "verified_by" not in response.json()
    assert "observation_id" not in response.json()


def test_property_mapping_uses_existing_alias_and_newest_scan(api):
    client, requests = api
    assert client.get("/api/properties/236314").json()["property_id"] == "236314"
    params = requests[-1].url.params
    assert params["costar_property_id"] == "eq.236314"
    assert params["matterport_model_id"] == "not.is.null"
    assert "property_id:costar_property_id" in params["select"]
    assert params["order"] == "created_at.desc,id.asc"
    assert client.get("/api/properties/invalid").status_code == 422


@pytest.mark.parametrize(
    "path",
    [
        "/api/stores/missing",
        "/api/properties/123",
        "/api/products/missing",
        "/api/products/missing/location",
        "/api/stores/missing/maps",
        "/api/stores/missing/products",
        "/api/maps/missing/nodes",
    ],
)
def test_missing_or_invisible_parent_returns_404(api, path):
    client, _ = api
    with httpx.Client(
        base_url="https://example.supabase.co/rest/v1/",
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json=[])),
    ) as upstream:
        client.app.state.database = ReadDatabase(upstream)
        assert client.get(path).status_code == 404


@pytest.mark.parametrize(
    "body",
    [[], [{"id": "store-1", "name": "Demo", "width_m": 30, "height_m": 20, "created_at": NOW}]],
)
def test_store_page_can_be_empty_or_populated(api, body):
    client, _ = api
    with httpx.Client(
        base_url="https://example.supabase.co/rest/v1/",
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json=body)),
    ) as upstream:
        client.app.state.database = ReadDatabase(upstream)
        response = client.get("/api/stores")
        assert response.status_code == 200
        assert len(response.json()["items"]) == len(body)


@pytest.mark.parametrize("failure", ["forbidden", "timeout", "invalid-json", "invalid-shape"])
def test_database_errors_are_sanitized(api, failure):
    client, _ = api

    def respond(request):
        if failure == "timeout":
            raise httpx.ReadTimeout("secret credential", request=request)
        if failure == "invalid-json":
            return httpx.Response(200, text="secret credential")
        if failure == "invalid-shape":
            return httpx.Response(200, json={"secret": "credential"})
        return httpx.Response(403, json={"message": "secret credential"})

    with httpx.Client(
        base_url="https://example.supabase.co/rest/v1/", transport=httpx.MockTransport(respond)
    ) as upstream:
        client.app.state.database = ReadDatabase(upstream)
        response = client.get("/api/stores")
        assert response.status_code == 503
        assert response.json() == {"detail": "Database read unavailable"}


def test_health_docs_and_missing_configuration():
    with TestClient(create_app(no_database_settings())) as client:
        assert client.get("/health").json() == {"status": "ok"}
        assert client.get("/health/ready").status_code == 503
        assert client.get("/api/stores").status_code == 503
        assert client.get("/docs").status_code == 200
        schema = client.get("/openapi.json").json()
        assert all(set(methods) == {"get"} for methods in schema["paths"].values())
        assert not any("agent" in path or "auth" in path for path in schema["paths"])
        assert client.post("/api/stores", json={}).status_code == 405


def test_cors_only_allows_reads_from_frontend(api):
    client, _ = api
    headers = {"Origin": "http://localhost:3000", "Access-Control-Request-Method": "GET"}
    assert client.options("/api/stores", headers=headers).status_code == 200
    headers["Access-Control-Request-Method"] = "POST"
    assert client.options("/api/stores", headers=headers).status_code == 400
    headers["Access-Control-Request-Method"] = "GET"
    headers["Origin"] = "https://unlisted.example"
    assert client.options("/api/stores", headers=headers).status_code == 400


def test_settings_reuse_frontend_environment_without_service_role(monkeypatch):
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_ANON_KEY", raising=False)
    monkeypatch.setenv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "public-anon-key")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "never-use-this")
    settings = Settings(_env_file=None)
    assert settings.database_configured
    assert settings.supabase_anon_key.get_secret_value() == "public-anon-key"
    monkeypatch.delenv("NEXT_PUBLIC_SUPABASE_ANON_KEY")
    assert not Settings(_env_file=None).database_configured


@pytest.mark.parametrize("key", ["legacy-anon-jwt", "sb_publishable_example"])
def test_configured_lifespan_uses_public_key_and_closes_client(monkeypatch, key):
    original_client = httpx.Client
    requests = []
    clients = []

    def respond(request):
        requests.append(request)
        return httpx.Response(200, json=[])

    def make_client(**kwargs):
        upstream = original_client(transport=httpx.MockTransport(respond), **kwargs)
        clients.append(upstream)
        return upstream

    settings = Settings(
        _env_file=None,
        SUPABASE_URL="https://example.supabase.co",
        SUPABASE_ANON_KEY=key,
    )
    app = create_app(settings)
    monkeypatch.setattr("app.main.httpx.Client", make_client)
    with TestClient(app) as client:
        assert client.get("/health/ready").status_code == 200
        assert requests[0].headers["apikey"] == key
        assert requests[0].url.path == "/rest/v1/stores"
        assert requests[0].method == "GET"
        if key.startswith("sb_publishable_"):
            assert "authorization" not in requests[0].headers
        else:
            assert requests[0].headers["authorization"] == f"Bearer {key}"
    assert clients[0].is_closed
    assert app.state.database is None
