// Vexcel ortho imagery. Server-only. Header X-API-KEY; coverage is Houston and Los Angeles only (403 elsewhere).
const VEXCEL = "https://api.vexcelgroup.com/v2";
const M_PER_DEG = 111_320;

export function vexcelConfigured(): boolean {
  return Boolean(process.env.VEXCEL_API_KEY);
}

/** WKT square around a point, half_m meters from center to edge. Note WKT is lon-lat order. */
export function squareWkt(lat: number, lon: number, halfM: number): string {
  const dlat = halfM / M_PER_DEG;
  const dlon = halfM / (M_PER_DEG * Math.cos((lat * Math.PI) / 180));
  const [w, e, s, n] = [lon - dlon, lon + dlon, lat - dlat, lat + dlat];
  return `POLYGON((${w} ${s},${e} ${s},${e} ${n},${w} ${n},${w} ${s}))`;
}

/** North-up orthophoto clipped to a square around (lat, lon), as a JPEG data URL. Null when out of coverage. */
export async function orthoAround(lat: number, lon: number, halfM = 70, px = 1024): Promise<string | null> {
  const res = await fetch(`${VEXCEL}/ortho/extract`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-API-KEY": process.env.VEXCEL_API_KEY ?? "" },
    body: JSON.stringify({
      wkt: squareWkt(lat, lon, halfM),
      srid: 4326,
      layer: "urban,urban-r,wide-area,urban-g",
      crop: "bounding_box",
      "image-format": "jpeg",
      "destination-dimensions": `${px},${px}`,
      attribution: "false",
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 403) return null; // outside Houston / LA
  if (res.status === 401) throw new Error("Vexcel rejected the key (401). Check VEXCEL_API_KEY.");
  if (!res.ok) throw new Error(`Vexcel HTTP ${res.status}`);
  return `data:image/jpeg;base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
}
