# IceBuddy

Shared ice-thickness reports for Minnesota lakes. People drop a pin with what they measured, and the map
blends recent reports across each lake, clipped to the real DNR shoreline.

## Layout

| Path | What it is |
|---|---|
| `pipeline/` | Builds a region pack from the Minnesota DNR Hydrography Dataset: vector tiles, a search index and outlines. See `pipeline/regions/mn.json`. |
| `data/mn/lake_outlines.geojsonl.gz` | Lake outlines for the database (about 5 m detail). |
| `public/data/mn/` | What the app loads: `lakes.pmtiles` (z4 to z12), `lake_index.json` for search, `borders.json`. |
| `scripts/load-lakes.mjs` | Sends the outlines to the `load-lakes` Supabase function. |
| `.github/workflows/load-lakes.yml` | Runs that loader on every change to the outlines on `main`, or by hand from the Actions tab. |

## Database (Supabase)

Project `icebuddy`, region us-east-2 (Ohio).

- `lakes`: one row per lake, keyed `mn:<DNR lake number>`.
- `readings`: each person's reported thickness at a point.
  - A trigger rejects any point that is not inside its lake's outline.
  - Row-level security means you can only add, change or delete your own readings.
- `lake_stats`: per-lake average over the last 30 days, weighted toward newer reports.

The loader proves it is this repository's workflow with a GitHub OIDC token, so the repo holds no database secrets.

## Rebuilding the lake data

```
pip install -r pipeline/requirements.txt
python pipeline/build_lakes.py SOURCE.zip --region pipeline/regions/mn.json --out pipeline/dist/mn
```

The source is the DNR Hydrography Dataset, layer "Dnr Hydro Features All", on https://gis.data.mn.gov/ (item
d26eb1d402e84c4db9a302d29f4fc1c9). Copy `lakes.pmtiles` and `lake_index.json` into `public/data/mn/`, and gzip
`lake_outlines.geojsonl` into `data/mn/`.

Lake outlines: Minnesota DNR, DNR Hydrography Dataset.
