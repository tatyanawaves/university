#!/usr/bin/env python3
"""Real star systems for the Unreal port, as DataTable CSVs.

Downloads the NASA Exoplanet Archive's composite table (every confirmed
planet, one row each, with its host star) and writes two files Unreal imports
as DataTables (row structs FRealStarRow and FRealPlanetRow):

    unreal/Data/RealStars.csv    one row per host star
    unreal/Data/RealPlanets.csv  one row per planet, keyed to its star

Run it once, or whenever the catalogue should be refreshed; the game then
reads the tables offline. Nothing here goes through a language model.

    python3 unreal/Tools/build_catalog.py
"""

import csv
import io
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

TAP = "https://exoplanetarchive.ipac.caltech.edu/TAP/sync"
COLUMNS = [
    "pl_name", "hostname", "sy_dist", "ra", "dec", "st_spectype", "st_teff", "st_rad", "st_mass", "st_lum",
    "pl_orbsmax", "pl_orbeccen", "pl_orbincl", "pl_orbper", "pl_rade", "pl_bmasse", "pl_eqt", "disc_year",
]
OUT = Path(__file__).resolve().parent.parent / "Data"


def fetch() -> list[dict]:
    query = f"select {','.join(COLUMNS)} from pscomppars"
    url = f"{TAP}?{urllib.parse.urlencode({'query': query, 'format': 'csv'})}"
    with urllib.request.urlopen(url, timeout=120) as r:
        return list(csv.DictReader(io.TextIOWrapper(r, encoding="utf-8")))


def key(name: str) -> str:
    """A DataTable row name: letters, digits and underscores."""
    return re.sub(r"[^A-Za-z0-9]+", "_", name).strip("_")


def num(x: str, default: float = 0.0) -> str:
    try:
        return f"{float(x):.6g}"
    except (TypeError, ValueError):
        return f"{default:.6g}"


def main() -> None:
    rows = fetch()
    OUT.mkdir(parents=True, exist_ok=True)
    stars: dict[str, dict] = {}
    for r in rows:
        stars.setdefault(r["hostname"], r)

    with open(OUT / "RealStars.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["---", "Name", "DistancePc", "RaDeg", "DecDeg", "SpectralType", "TeffK", "RadiusSun", "MassSun", "Log10LumSun", "PlanetCount"])
        count = {}
        for r in rows:
            count[r["hostname"]] = count.get(r["hostname"], 0) + 1
        for name, r in sorted(stars.items(), key=lambda kv: float(kv[1]["sy_dist"] or 1e9)):
            w.writerow([key(name), name, num(r["sy_dist"], -1), num(r["ra"]), num(r["dec"]), r["st_spectype"],
                        num(r["st_teff"], 5772), num(r["st_rad"], 1), num(r["st_mass"], 1), num(r["st_lum"]), count[name]])

    with open(OUT / "RealPlanets.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["---", "Name", "Star", "SemiMajorAu", "Eccentricity", "InclinationDeg", "PeriodDays", "RadiusEarth", "MassEarth", "EqTempK", "DiscoveryYear"])
        for r in sorted(rows, key=lambda r: (r["hostname"], float(r["pl_orbsmax"] or r["pl_orbper"] or 0))):
            w.writerow([key(r["pl_name"]), r["pl_name"], key(r["hostname"]), num(r["pl_orbsmax"], -1), num(r["pl_orbeccen"]),
                        num(r["pl_orbincl"], 90), num(r["pl_orbper"], -1), num(r["pl_rade"], -1), num(r["pl_bmasse"], -1),
                        num(r["pl_eqt"], -1), r["disc_year"]])

    print(f"{len(stars)} stars, {len(rows)} planets -> {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
