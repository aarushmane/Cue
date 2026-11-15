# Wayfinding inputs

Put one file per Matterport model here, named `<modelId>.json` (for example `Muo5jpq44Xk.json`). It is loaded by
`lib/wayfinding/scene.ts` and merged with Matterport's scan points and walls. The same `items` / `obstacles` can
also be sent with each API request. Coordinates are in the Matterport **Model API frame** (metres, z up — the frame
of `panoLocations.position`). See `docs/wayfinding.md` for the full contract.

```json
{
  "items": [
    { "id": "chips-1", "name": "Potato chips", "aliases": ["crisps"], "category": "snacks",
      "position": { "x": -6.2, "y": 3.4, "z": 1.0 }, "floorId": null, "source": "staff" }
  ],
  "obstacles": [
    { "kind": "box", "label": "Aisle 1 shelf", "minX": -5.0, "minY": 0.9, "maxX": -4.4, "maxY": 2.0 },
    { "kind": "wall", "ax": 0, "ay": 0, "bx": 4, "by": 0 }
  ]
}
```

The values above are an illustration of the format, not measurements of the scan.

## Product catalogue (`<modelId>.catalog.json`)

Products read from the scan's own photos, each placed in 3D, so brand and category searches ("takis", "soda") are
answered without any AI call. Build or refresh it with the app running:

```sh
npm run wayfinding:catalog -- <modelId> [--url http://localhost:3000]
```

That reads each photo face once (about 12 vision calls) and writes this file. Entries are `SceneItem`s
(`source: "vision"`); edit or delete wrong ones by hand. Searches not covered here fall back to a live photo search.
