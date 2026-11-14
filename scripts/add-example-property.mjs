// Call the real API; credentials stay in the local environment and are never printed.
const token = process.env.PROPERTY_WRITE_TOKEN;
if (!token) throw new Error("Set PROPERTY_WRITE_TOKEN before adding a property.");
const response = await fetch(new URL("/api/db/properties", process.env.APP_URL || "http://localhost:3000"), {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({
    property_id: "236314",
    matterport_model_id: "Muo5jpq44Xk",
    name: "Sample Storefront",
    address: "6301–6335 Ashcroft Dr, Houston, TX",
  }),
});
if (!response.ok) throw new Error(`Property API returned HTTP ${response.status}.`);
const result = await response.json();
console.log(JSON.stringify(result, null, 2));
