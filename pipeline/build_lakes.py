#!/usr/bin/env python3
"""IceBuddy lake data build: one source file in, one region pack out.

    python build_lakes.py SOURCE --region regions/mn.json --out dist/mn [--layer NAME] [--inspect]

SOURCE is the downloaded polygon dataset (.zip of a shapefile or geopackage, .gpkg, .shp, or .geojson).
Run with --inspect first to list its layers and fields without building anything.

Output (the "region pack"):
  lakes.pmtiles          vector tiles, layer "lakes" (id, name, acres). The app reads only on-screen tiles.
  lake_index.json        search and list data: id, name, county, center, bbox, acres.
  lake_outlines.geojsonl one simplified outline per line, for loading into the database
                         (server-side geofence and the heatmap clip).
  build_report.md        counts, unnamed lakes, repeated names, file sizes.

Every lake keeps one stable id: "<region>:<DNR lake number>" when the source has one,
otherwise "<region>:x<hash of its location>". Lakes are never merged or dropped by name.
"""
import argparse, gzip, hashlib, json, math, os, sys, time
from collections import Counter
from multiprocessing import Pool

import geopandas as gpd
import pyogrio
import shapely
from shapely import STRtree, box
from shapely.geometry import mapping

WEB = 20037508.342789244          # half the Web Mercator world width, meters
EXTENT, BUFFER = 4096, 64          # tile coordinate space and edge buffer


# ---------------------------------------------------------------- reading
def vsi(path):
    p = os.path.abspath(path)
    return "/vsizip/" + p if p.lower().endswith(".zip") else p

def inspect(path):
    layers = pyogrio.list_layers(vsi(path))
    if len(layers) == 0 and path.lower().endswith(".zip"):   # shapefiles nested in folders inside the zip
        import zipfile
        shp = [n for n in zipfile.ZipFile(path).namelist() if n.lower().endswith((".shp", ".gpkg"))]
        return [(vsi(path) + "/" + n, None) for n in shp]
    return [(vsi(path), name) for name, _ in layers]

def describe(path):
    print(f"Layers in {path}:")
    for src, layer in inspect(path):
        info = pyogrio.read_info(src, layer=layer)
        print(f"\n  {layer or src}\n    geometry: {info['geometry_type']}   features: {info['features']}   crs: {info['crs']}")
        print("    fields: " + ", ".join(info["fields"]))

def pick_layer(path, wanted):
    best = None
    for src, layer in inspect(path):
        if wanted and wanted not in (layer, os.path.basename(src)):
            continue
        info = pyogrio.read_info(src, layer=layer)
        if "Polygon" not in (info["geometry_type"] or ""):
            continue
        if best is None or info["features"] > best[2]:
            best = (src, layer, info["features"])
    if not best:
        sys.exit("No polygon layer found. Run with --inspect and pass --layer.")
    return best[0], best[1]

def find_field(columns, candidates):
    low = {c.lower(): c for c in columns}
    for c in candidates or []:
        if c.lower() in low:
            return low[c.lower()]
    return None


# ---------------------------------------------------------------- preparing
def clean_str(v):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return ""
    s = str(v).strip()
    return "" if s.lower() in ("", "none", "null", "unnamed", "0") else s

def lake_number(v):
    s = clean_str(v)
    if not s:
        return ""
    try:
        n = int(float(s))
        return "" if n <= 0 else f"{n:08d}"
    except ValueError:
        return s

def prepare(gdf, cfg):
    f = cfg["fields"]
    cols = list(gdf.columns)
    col = {k: find_field(cols, f.get(k)) for k in ("lake_number", "name", "county", "kind", "uid")}
    print("Field mapping:", {k: v or "(not found)" for k, v in col.items()})
    if not col["name"]:
        print("  warning: no name field matched; lakes will be unnamed. Add the right field to the region config.")

    gdf = gdf[gdf.geometry.notna()].copy()
    gdf["geometry"] = shapely.make_valid(gdf.geometry.values)
    gdf = gdf[gdf.geom_type.isin(["Polygon", "MultiPolygon", "GeometryCollection"])]
    gdf["geometry"] = [g if g.geom_type != "GeometryCollection" else
                       shapely.union_all([p for p in g.geoms if p.geom_type in ("Polygon", "MultiPolygon")])
                       for g in gdf.geometry]
    for field, values in (cfg.get("exclude") or {}).items():
        real = find_field(cols, [field])
        if real:
            before = len(gdf)
            gdf = gdf[~gdf[real].astype(str).isin([str(v) for v in values])]
            print(f"  excluded {before - len(gdf):,} rows where {real} is {values}")
    if col["kind"] and cfg.get("keep_kinds"):
        keep = {k.lower() for k in cfg["keep_kinds"]}
        gdf = gdf[gdf[col["kind"]].astype(str).str.lower().isin(keep)]

    utm = gdf.to_crs(26915)                          # UTM 15N: Minnesota's working projection, for true areas
    gdf["acres"] = utm.geometry.area / 4046.8564224
    gdf["_num"] = gdf[col["lake_number"]].map(lake_number) if col["lake_number"] else ""
    gdf["_name"] = gdf[col["name"]].map(clean_str) if col["name"] else ""
    gdf["_county"] = gdf[col["county"]].map(clean_str) if col["county"] else ""
    gdf["_kind"] = gdf[col["kind"]].map(clean_str) if col["kind"] else ""
    gdf["_uid"] = gdf[col["uid"]].map(lake_number).str.lstrip("0") if col["uid"] else ""
    gdf = gdf.to_crs(4326)

    # Parts that share a DNR lake number are one lake. Everything else stays separate.
    numbered = gdf[gdf["_num"] != ""]
    if len(numbered):
        agg = numbered.dissolve(by="_num", aggfunc={"acres": "sum", "_name": first_nonempty,
                                                    "_county": first_nonempty, "_kind": first_nonempty,
                                                    "_uid": first_nonempty}).reset_index()
    else:
        agg = numbered
    loose = gdf[gdf["_num"] == ""]
    lakes = gpd.GeoDataFrame(
        [*agg[["_num", "_name", "_county", "_kind", "_uid", "acres", "geometry"]].itertuples(index=False),
         *loose[["_num", "_name", "_county", "_kind", "_uid", "acres", "geometry"]].itertuples(index=False)],
        columns=["num", "name", "county", "kind", "uid", "acres", "geometry"], crs=4326)
    lakes["name"] = [display_name(n, k) for n, k in zip(lakes.name, lakes.kind)]
    lakes = lakes[lakes.acres >= cfg.get("min_acres", 0)].reset_index(drop=True)

    rid = cfg["region_id"]
    def make_id(row):
        if row.num:
            return f"{rid}:{row.num}"
        if row.uid:
            return f"{rid}:u{row.uid}"
        p = row.geometry.representative_point()
        return f"{rid}:x" + hashlib.sha1(f"{p.x:.4f},{p.y:.4f}".encode()).hexdigest()[:10]
    lakes["id"] = [make_id(r) for r in lakes.itertuples()]
    dup = lakes["id"].duplicated(keep=False)
    if dup.any():   # two unnumbered lakes on the same rounded point: tell them apart by size order
        for _, grp in lakes[dup].groupby("id"):
            for k, i in enumerate(grp.sort_values("acres", ascending=False).index):
                if k:
                    lakes.at[i, "id"] = f"{lakes.at[i, 'id']}-{k}"
    return lakes

WATER_WORDS = ("lake", "lac", "lacs", "river", "pond", "reservoir", "pit", "bay", "pool", "flowage",
               "basin", "slough", "marsh", "creek", "channel", "mine", "of the")
LAKE_FIRST = set()
def display_name(name, kind):
    """DNR names drop the word Lake ("Leech"). Add it back for lakes, the way people say it."""
    if name.endswith(" (MN)"):
        name = name[:-5]
    if not name or kind != "Lake or Pond":
        return name
    if name in LAKE_FIRST:
        return f"Lake {name}"
    words = name.lower().replace("(", " ").replace("-", " ").split()
    if any(w in words for w in WATER_WORDS) or "of the" in name.lower():
        return name
    if "(" in name:   # "Goose (South)" -> "Goose Lake (South)"
        base, rest = name.split("(", 1)
        return f"{base.strip()} Lake ({rest}"
    return f"{name} Lake"

def first_nonempty(s):
    for v in s:
        if v:
            return v
    return ""


# ---------------------------------------------------------------- tiles
def tile_bounds(z, x, y):
    size = 2 * WEB / 2 ** z
    minx = -WEB + x * size
    maxy = WEB - y * size
    return minx, maxy - size, minx + size, maxy

def lonlat_to_tile(lon, lat, z):
    n = 2 ** z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return min(max(x, 0), n - 1), min(max(y, 0), n - 1)

_G = {}
def _init(geoms, props, tree_geoms):
    _G["geoms"], _G["props"], _G["tree"] = geoms, props, STRtree(tree_geoms)

def _tile(args):
    import mapbox_vector_tile
    z, x, y = args
    minx, miny, maxx, maxy = tile_bounds(z, x, y)
    pad = (maxx - minx) * BUFFER / EXTENT
    clip = box(minx - pad, miny - pad, maxx + pad, maxy + pad)
    feats = []
    k = EXTENT / (maxx - minx)
    for i in _G["tree"].query(clip, predicate="intersects"):
        g = shapely.clip_by_rect(_G["geoms"][i], *clip.bounds)
        if g.is_empty:
            continue
        # Move into tile units and snap to the integer grid here, so the shape stays valid.
        # Letting the encoder round the coordinates made self-intersecting rings, which
        # MapLibre fills as stray triangles at low zoom.
        g = shapely.transform(g, lambda c: (c - (minx, miny)) * k)
        g = shapely.set_precision(shapely.make_valid(g), 1.0)
        polys = [p for p in getattr(g, "geoms", [g]) if p.geom_type in ("Polygon", "MultiPolygon") and not p.is_empty]
        if not polys:
            continue
        g = shapely.union_all(polys)
        if g.is_empty or g.area < 1:
            continue
        feats.append({"geometry": g.wkt, "properties": _G["props"][i]})
    if not feats:
        return None
    data = mapbox_vector_tile.encode([{"name": "lakes", "features": feats}],
                                     default_options={"extents": EXTENT})
    return z, x, y, gzip.compress(data, 9)

def build_tiles(lakes, cfg, out_path, workers):
    from pmtiles.tile import zxy_to_tileid, TileType, Compression
    from pmtiles.writer import write
    merc = lakes.to_crs(3857)
    zmin, zmax = cfg["min_zoom"], cfg["max_zoom"]
    thresholds = {int(k): v for k, v in cfg.get("zoom_min_acres", {}).items()}
    b = cfg["bounds"]
    results = []
    for z in range(zmin, zmax + 1):
        keep = merc[merc.acres >= thresholds.get(z, 0)]
        tol = 2 * WEB / 2 ** z / EXTENT                     # one tile pixel, in meters
        geoms = shapely.simplify(keep.geometry.values, tol, preserve_topology=True)
        props = [{"id": r.id, "name": r.name, "acres": round(float(r.acres))} for r in keep.itertuples()]
        x0, y0 = lonlat_to_tile(b[0], b[3], z)
        x1, y1 = lonlat_to_tile(b[2], b[1], z)
        jobs = [(z, x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
        t = time.time()
        with Pool(workers, initializer=_init, initargs=(geoms, props, geoms)) as pool:
            got = [r for r in pool.imap_unordered(_tile, jobs, chunksize=8) if r]
        results += got
        print(f"  z{z}: {len(keep):,} lakes, {len(got):,} tiles ({time.time() - t:.0f}s)")
    results.sort(key=lambda r: zxy_to_tileid(r[0], r[1], r[2]))
    with write(out_path) as w:
        for z, x, y, data in results:
            w.write_tile(zxy_to_tileid(z, x, y), data)
        c = cfg["center"]
        w.finalize({
            "tile_type": TileType.MVT, "tile_compression": Compression.GZIP,
            "min_zoom": zmin, "max_zoom": zmax,
            "min_lon_e7": int(b[0] * 1e7), "min_lat_e7": int(b[1] * 1e7),
            "max_lon_e7": int(b[2] * 1e7), "max_lat_e7": int(b[3] * 1e7),
            "center_zoom": int(c[2]), "center_lon_e7": int(c[0] * 1e7), "center_lat_e7": int(c[1] * 1e7),
        }, {
            "name": f"IceBuddy lakes ({cfg['name']})", "attribution": cfg["source"]["attribution"],
            "vector_layers": [{"id": "lakes", "fields": {"id": "String", "name": "String", "acres": "Number"},
                               "minzoom": zmin, "maxzoom": zmax}],
        })
    return len(results)


# ---------------------------------------------------------------- index, outlines, report
def write_index(lakes, cfg, path):
    rows = []
    for r in lakes.itertuples():
        if not r.name and r.acres < cfg.get("index_min_acres", 0):
            continue
        p = r.geometry.representative_point()
        rows.append([r.id, r.name, r.county, round(p.x, 5), round(p.y, 5),
                     [round(v, 5) for v in r.geometry.bounds], round(float(r.acres))])
    rows.sort(key=lambda x: (x[1] == "", x[1].lower(), -x[6]))
    doc = {"region": cfg["region_id"], "attribution": cfg["source"]["attribution"],
           "columns": ["id", "name", "county", "lon", "lat", "bbox", "acres"], "lakes": rows}
    with open(path, "w") as f:
        json.dump(doc, f, separators=(",", ":"))
    return len(rows)

def write_outlines(lakes, path):
    utm = lakes.to_crs(26915)
    simple = gpd.GeoSeries(shapely.simplify(utm.geometry.values, 5, preserve_topology=True), crs=26915).to_crs(4326)
    with open(path, "w") as f:
        for r, g in zip(lakes.itertuples(), simple):
            f.write(json.dumps({"type": "Feature", "properties": {"id": r.id, "name": r.name, "county": r.county,
                                "acres": round(float(r.acres), 1), "kind": r.kind},
                                "geometry": mapping(shapely.set_precision(g, 1e-6))}, separators=(",", ":")) + "\n")

def write_report(lakes, cfg, out, n_tiles, n_index, src, layer, secs):
    size = lambda p: f"{os.path.getsize(os.path.join(out, p)) / 1e6:.1f} MB"
    named = lakes[lakes.name != ""]
    rep = Counter(named.name).most_common(12)
    lines = [f"# Build report: {cfg['name']}", "",
             f"- Source: `{os.path.basename(src)}`" + (f", layer `{layer}`" if layer else ""),
             f"- Built {time.strftime('%Y-%m-%d %H:%M')} in {secs / 60:.1f} min", "",
             "| | |", "|---|---|",
             f"| Lakes kept (≥ {cfg.get('min_acres', 0)} acres) | {len(lakes):,} |",
             f"| With a DNR lake number | {(lakes.num != '').sum():,} |",
             f"| With a name | {len(named):,} |",
             f"| Unnamed | {len(lakes) - len(named):,} |",
             f"| In the search index | {n_index:,} |",
             f"| Map tiles | {n_tiles:,} |", "",
             "| File | Size |", "|---|---|",
             *[f"| {p} | {size(p)} |" for p in ("lakes.pmtiles", "lake_index.json", "lake_outlines.geojsonl")], "",
             "## Most repeated names (all kept as separate lakes)", "",
             *[f"- {n}: {c}" for n, c in rep], ""]
    with open(os.path.join(out, "build_report.md"), "w") as f:
        f.write("\n".join(lines))
    print("\n".join(lines))


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source")
    ap.add_argument("--region", default=os.path.join(os.path.dirname(__file__), "regions", "mn.json"))
    ap.add_argument("--out", default=None)
    ap.add_argument("--layer", default=None)
    ap.add_argument("--inspect", action="store_true")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    a = ap.parse_args()
    if a.inspect:
        return describe(a.source)
    cfg = json.load(open(a.region))
    out = a.out or os.path.join("dist", cfg["region_id"])
    os.makedirs(out, exist_ok=True)
    t0 = time.time()
    src, layer = pick_layer(a.source, a.layer)
    print(f"Reading {layer or src} ...")
    gdf = gpd.read_file(src, layer=layer, engine="pyogrio")
    if gdf.crs is None:
        sys.exit("The source has no coordinate system. Fix the file before building.")
    print(f"  {len(gdf):,} features")
    LAKE_FIRST.update(cfg.get("lake_first_names", []))
    lakes = prepare(gdf, cfg)
    print(f"  {len(lakes):,} lakes after cleanup")
    n_index = write_index(lakes, cfg, os.path.join(out, "lake_index.json"))
    write_outlines(lakes, os.path.join(out, "lake_outlines.geojsonl"))
    print("Building tiles ...")
    n_tiles = build_tiles(lakes, cfg, os.path.join(out, "lakes.pmtiles"), a.workers)
    write_report(lakes, cfg, out, n_tiles, n_index, a.source, layer, time.time() - t0)

if __name__ == "__main__":
    main()
