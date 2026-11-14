# Venue landmarks: signs, reference photos and evaluation

Visual localization (`POST /api/localize`, `lib/vision/matchLandmark.ts`) asks the model which **one** reference landmark is visible in 1–3 camera frames. The model is told to answer `null` rather than guess between similar landmarks, and code (`decidePosition`) turns its confidence into CONFIRMED / LIKELY / UNKNOWN. So localization is only as good as how **distinct** the landmarks are.

## Why the old descriptions struggled

`DEMO_LANDMARKS` (lib/seed/demo-store.ts) before this change:

| id | node | description |
|---|---|---|
| L01 | N01 | Entrance doors with a green STOREGUIDE welcome sign |
| L02 | N02 | Hanging sign reading AISLE 1 – PRODUCE & BAKERY (red) |
| L03 | N03 | Hanging sign reading AISLE 2 – DAIRY (blue) |
| L04 | N04 | Hanging sign reading AISLE 3 – PANTRY (yellow) |
| L05 | N05 | Help desk counter with a bell and a HELP sign |

Problems:
1. **L02–L04 share one template** ("Hanging sign reading AISLE n – …"). From a blurry or partial frame the only difference is a small number or a color, which is exactly when the model should, and will, answer `null`.
2. **"Hanging" puts them overhead.** A shopper holds the phone at chest height and pans left to right, so overhead signs are often out of frame.
3. **Color is said once, at the end.** Color is the feature that survives blur, distance and low light best, so it should come first.
4. **No reference photos exist** (`public/demo/landmarks/` is empty), so matching uses text only.

## The signs (applied to `DEMO_LANDMARKS` and `supabase/seed.sql`)

**Print them from `/signs`** (`npm run dev` → http://localhost:3000/signs → Print: A4 landscape, one sign per page, or scale to A3). The page shows each sign with the exact description the model gets.

Each sign differs from every other on **five channels**: color, shape, numeral, word, icon. Any two of them are enough for a confident match on a partial view.

| id | Physical sign (A3 or larger, matte, 1.2–1.5 m off the floor, facing the walkway) | Proposed description |
|---|---|---|
| L01 | Green rectangle banner on the entrance doors: "WELCOME TO STOREGUIDE" in white capitals with a shopping-cart icon | `GREEN rectangular banner on the entrance doors reading "WELCOME TO STOREGUIDE" in white capitals, with a shopping-cart icon. The only green sign.` |
| L02 | Red **square**, huge white numeral **1**, words PRODUCE & BAKERY, apple icon | `RED SQUARE sign with a huge white number 1 and the words "PRODUCE & BAKERY", apple icon. The only red sign and the only square one.` |
| L03 | Blue **circle**, huge white numeral **2**, word DAIRY, milk-carton icon | `BLUE ROUND sign with a huge white number 2 and the word "DAIRY", milk-carton icon. The only round sign.` |
| L04 | Yellow **triangle** (point up), huge black numeral **3**, word PANTRY, tin-can icon | `YELLOW TRIANGLE sign, point up, with a huge black number 3 and the word "PANTRY", tin-can icon. The only triangular sign.` |
| L05 | Orange sign on the help-desk counter: "HELP" with a question-mark icon, next to a silver call bell | `ORANGE sign reading "HELP" with a question-mark icon, standing on a counter next to a silver call bell. The only orange sign.` |

Rules that keep it working:
- Lead every description with the **color and shape in capitals**, then the big text, then the icon, then "the only …". The model weighs the start of each line most.
- Use only words that are **actually printed** on the sign, in quotes. The model matches legible text with high confidence.
- Don't reuse a color anywhere else in view (no red fire-safety poster next to the yellow sign).
- If a sign changes, update both `app/signs/page.tsx` and `DEMO_LANDMARKS`, then run `npm run seed:sql` so Supabase gets the same descriptions.

## Reference photos

Matching is more reliable with one reference photo per landmark, at a token cost on every scan (5 extra images). Compare both ways with the eval below before deciding.

1. Stand on the landmark's node (where a shopper would stand), phone at chest height, sign filling about a third of the frame.
2. Save as `public/demo/landmarks/L01.jpg` … `L05.jpg`: JPEG, PNG or WebP, **under 1.5 MB** (`sips -Z 1280 L01.jpg` resizes on a Mac).
3. Restart isn't needed: a missing photo is re-checked about once a minute. The server log says which photos are missing, too big, or the wrong type.
4. `LANDMARK_REFERENCE_IMAGES=off` in `.env.local` sends descriptions only (saves quota during development).

## Evaluate in the venue

```bash
# 1. Photos (never committed: data/venue-scans/ is git-ignored)
data/venue-scans/L01/*.jpg   # about 10 per landmark: different distances, angles, lighting, partly blocked
data/venue-scans/L02/*.jpg
...
data/venue-scans/none/*.jpg  # about 10 with NO landmark: plain shelves, corridors, people (should come back UNKNOWN)

# 2. Run against the dev server (each photo = one vision call; the default 4 s delay respects the free tier)
npm run dev
npm run eval:localize -- --dir data/venue-scans --out data/localize-eval.json
npm run eval:localize -- --group 3            # like the app: 3 frames per scan
npm run eval:localize -- --prev N02           # with a previous position (adjacency can raise confidence)
```

The report prints a confusion table, the CONFIRMED / LIKELY / UNKNOWN breakdown per landmark, the median latency, and the model's own evidence text per landmark. **Use the evidence words in the descriptions:** if the model keeps saying "blue circular sign", say "BLUE ROUND sign".

**Demo bar:** each landmark correct in at least 8 of 10 photos, every `none` photo UNKNOWN, and **0 "wrong but confident"**. A confident wrong match starts guidance from the wrong place, which is worse than asking the shopper to scan again.

Privacy: photos stay in the folder you choose and are sent once to your own server with `share_sightings: false`, so evaluation never touches inventory. The output JSON holds text only. The server never stores or logs frames (docs/contracts.md invariants).
