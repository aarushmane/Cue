import { expect, test, type Page } from "@playwright/test";

// Supabase mode against the stub (tests/e2e-auth/stub-supabase.mjs). See playwright.auth.config.ts.
const stub = () => test.info().config.metadata.stubUrl as string;
const authCookies = async (page: Page) => (await page.context().cookies()).filter((c) => c.name.startsWith("sb-"));

async function signIn(page: Page, email: string, password = "correct-horse") {
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test.beforeEach(async ({ request }) => {
  await request.post(`${stub()}/__reset`);
});

test("signed out: manager pages redirect to sign-in, and a wrong password is explained", async ({ page }) => {
  await page.goto("/business/review");
  await expect(page).toHaveURL(/\/business\/sign-in\?next=%2Fbusiness%2Freview$/);
  await expect(page.getByRole("navigation", { name: "Manager" })).toHaveCount(0);
  await signIn(page, "staff@example.com", "wrong-password");
  await expect(page.locator("#sign-in-error")).toHaveText("That email and password don’t match a staff account. Check both and try again.");
  expect(await authCookies(page)).toHaveLength(0);
});

test("sign in → back where you were, email in the shell, session survives reloads → sign out", async ({ page }) => {
  await page.goto("/business/review");
  await signIn(page, "staff@example.com");
  await expect(page).toHaveURL(/\/business\/review$/);
  await expect(page.getByText("Signed in as staff@example.com")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Manager" })).toBeVisible();

  // The session lives in cookies the proxy can read: a full reload stays signed in.
  const cookies = await authCookies(page);
  expect(cookies.length).toBeGreaterThan(0);
  expect(cookies.every((c) => c.sameSite === "Lax" && c.path === "/")).toBe(true);
  await page.reload();
  await expect(page.getByText("Signed in as staff@example.com")).toBeVisible();

  // Signed in: the sign-in page sends you on to the manager app.
  await page.goto("/business/sign-in");
  await expect(page).toHaveURL(/\/business$/);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/business\/sign-in$/);
  expect(await authCookies(page)).toHaveLength(0);
  expect((await (await page.request.get(`${stub()}/__stats`)).json()).logouts).toBe(1);
  await page.goto("/business");
  await expect(page).toHaveURL(/\/business\/sign-in\?next=%2Fbusiness$/);
});

test("an expiring access token is refreshed by the proxy and the employee stays signed in", async ({ page }) => {
  await page.goto("/business");
  await signIn(page, "short@example.com");
  await expect(page.getByText("Signed in as short@example.com")).toBeVisible();
  const before = (await (await page.request.get(`${stub()}/__stats`)).json()).refreshes;
  await page.goto("/business/more");
  await expect(page.getByText("Signed in as short@example.com")).toBeVisible();
  const after = (await (await page.request.get(`${stub()}/__stats`)).json()).refreshes;
  expect(after).toBeGreaterThan(before);
});

test("a signed-in account that isn't store staff sees an explanation, not the manager screens", async ({ page }) => {
  await page.goto("/business");
  await signIn(page, "visitor@example.com");
  await expect(page.getByRole("heading", { name: "This account isn’t store staff" })).toBeVisible();
  await expect(page.getByText("Signed in as visitor@example.com")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
});

test("signing out in another tab signs this tab out too", async ({ page, context }) => {
  await page.goto("/business");
  await signIn(page, "staff@example.com");
  await expect(page.getByText("Signed in as staff@example.com")).toBeVisible();
  const other = await context.newPage();
  await other.goto("/business/more");
  await other.getByRole("button", { name: "Sign out" }).click();
  await expect(other).toHaveURL(/\/business\/sign-in$/);
  await page.bringToFront();
  await expect(page).toHaveURL(/\/business\/sign-in$/, { timeout: 15_000 });
});
