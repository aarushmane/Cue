import { expect, test } from "@playwright/test";
import { resetDemo } from "./helpers";

// Staff/shopper write routes in memory mode. The dev server gets STAFF_DEMO_TOKEN from playwright.config.ts.
const TOKEN = process.env.STAFF_DEMO_TOKEN || "e2e-staff";
const staff = { authorization: `Bearer ${TOKEN}` };

test.beforeEach(async ({ page }) => resetDemo(page));

test("review route: auth, reason check, reject, then 409 on a second review", async ({ request }) => {
  const url = "/api/observations/OBS-102/review";
  expect((await request.post(url, { data: { action: "reject", obs_version: 1, reason: "wrong item" } })).status()).toBe(401);
  expect((await request.post(url, { headers: { authorization: "Bearer nope" }, data: { action: "reject", obs_version: 1, reason: "wrong item" } })).status()).toBe(401);
  expect((await request.post("/api/observations/OBS-999/review", { headers: staff, data: { action: "reject", obs_version: 1, reason: "x" } })).status()).toBe(404);

  const short = await request.post(url, { headers: staff, data: { action: "reject", obs_version: 1, reason: "no" } });
  expect(short.status()).toBe(422);

  const stale = await request.post(url, { headers: staff, data: { action: "reject", obs_version: 7, reason: "wrong item" } });
  expect(stale.status()).toBe(409);

  const ok = await request.post(url, { headers: staff, data: { action: "reject", obs_version: 1, reason: "wrong item" } });
  expect(ok.status()).toBe(200);
  expect(await ok.json()).toEqual({ observation_id: "OBS-102", status: "REJECTED", product_id: null, is_new: false });

  const again = await request.post(url, { headers: staff, data: { action: "rescan", obs_version: 2, reason: "try again" } });
  expect(again.status()).toBe(409);
  expect((await again.json()).code).toBe("ALREADY_REVIEWED");
});

test("review route: publish requires the reviewer's confirmations", async ({ request }) => {
  const draft = {
    name: "Califia Farms Oat Milk", brand: "Califia Farms", category: "Dairy alternatives", size: "48 oz", variant: "Original",
    aisle: "3", shelf: "S-A3-1", level: "middle", match: "new", targetVersion: null, idOk: false, locOk: false, obsVersion: 1,
  };
  const r = await request.post("/api/observations/OBS-105/review", { headers: staff, data: { action: "publish", obs_version: 1, draft } });
  expect(r.status()).toBe(422);
  expect((await r.json()).failing.length).toBeGreaterThan(0);

  const ok = await request.post("/api/observations/OBS-105/review", {
    headers: staff, data: { action: "publish", obs_version: 1, draft: { ...draft, idOk: true, locOk: true } },
  });
  expect(ok.status(), JSON.stringify(await ok.json())).toBe(200);
  const body = await ok.json();
  expect(body.is_new).toBe(true);
  const search = await (await request.get("/api/products?store_id=demo-store&query=califia%20oat%20milk")).json();
  expect(search.results.some((x: { product: { id: string } }) => x.product.id === body.product_id)).toBe(true);
});

test("location route: version check, move, and shopper search sees it", async ({ request }) => {
  const url = "/api/products/P01/location";
  expect((await request.patch(url, { data: { shelf_id: "S-A1-2", level: "top" } })).status()).toBe(401);
  expect((await request.patch(url, { headers: staff, data: { shelf_id: "S-A1-2", level: "sideways" } })).status()).toBe(400);
  expect((await request.patch(url, { headers: staff, data: { shelf_id: "S-A1-2", level: "top", expected_version: 99 } })).status()).toBe(409);

  const ok = await request.patch(url, { headers: staff, data: { shelf_id: "S-A1-2", level: "top", expected_version: 1 } });
  expect(ok.status()).toBe(200);
  expect(await ok.json()).toEqual({ location: { product_id: "P01", shelf_id: "S-A1-2", level: "top" }, version: 2 });

  const search = await (await request.get("/api/products?store_id=demo-store&query=bananas")).json();
  const p = search.results.find((r: { product: { id: string } }) => r.product.id === "P01").product;
  expect(p.location.shelfId).toBe("S-A1-2");
});

test("map routes: publish without a draft is refused", async ({ request }) => {
  const r = await request.post("/api/maps/map-demo-v1/publish", { headers: staff });
  expect(r.status()).toBe(422);
  expect((await request.post("/api/maps/map-demo-v1/publish")).status()).toBe(401);
  expect((await request.post("/api/maps/no-such-map/publish", { headers: staff })).status()).toBe(404);
});

test("shopper submission route: consent required, then submit and merge", async ({ request }) => {
  const candidate = { name: "Vanilla Skyr", brand: "Siggi's", category: "Dairy", size: "5.3 oz", variant: "Vanilla", aisle: "3", shelf: "S-A3-2", level: "middle" };
  const body = { store_id: "demo-store", confidence: "Medium", evidence: "Seen by a shopper scan.", candidate };
  expect((await request.post("/api/observations", { data: { ...body, consent: "declined" } })).status()).toBe(403);
  const first = await (await request.post("/api/observations", { data: { ...body, consent: "allowed" } })).json();
  expect(first.merged).toBe(false);
  const second = await (await request.post("/api/observations", { data: { ...body, consent: "allowed" } })).json();
  expect(second.merged).toBe(true);
  expect(second.id).toBe(first.id);
});
