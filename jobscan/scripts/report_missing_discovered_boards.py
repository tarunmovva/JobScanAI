#!/usr/bin/env python3
"""Report discovered ATS board slugs that are not in the current jobscan data.

This script is read-only for existing repo data. It creates a timestamped report
directory containing one CSV per board plus machine-readable and Markdown
summaries.
"""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Iterable


BOARDS = ("ashby", "greenhouse", "lever")
DATA_FILES = {
    "ashby": "data/finalworkingjobboardname_ashby.csv",
    "greenhouse": "data/finalworkingjobboardname_greenhouse.csv",
    "lever": "data/finalworkingjobboardname_lever.csv",
}


@dataclass
class Discovery:
    board: str
    slug: str
    normalized_slug: str
    api_url: str = ""
    board_url: str = ""
    source_company_name: str = ""
    source_dataset: str = ""
    source_datasets: str = ""
    source_native_id: str = ""
    source_country: str = ""
    source_jurisdiction: str = ""
    source_ticker: str = ""
    source_exchange: str = ""
    variant_kind: str = ""
    status: str = ""
    job_count: str = ""
    json_shape: str = ""
    first_file: str = ""
    files_seen: set[str] = field(default_factory=set)
    run_ids_seen: set[str] = field(default_factory=set)

    @property
    def appearances(self) -> int:
        return len(self.files_seen)


def normalize_slug(value: str) -> str:
    return value.strip().casefold()


def repo_root_from_script() -> Path:
    return Path(__file__).resolve().parents[1]


def latest_artifact_dir(repo_root: Path) -> Path:
    base = repo_root / "github-artifacts"
    candidates = sorted(
        (path for path in base.glob("ats-slug-discovery-actions-*") if path.is_dir()),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    if not candidates:
        raise FileNotFoundError(f"No ats-slug-discovery artifact folder found in {base}")
    return candidates[0]


def run_id_from_path(path: Path) -> str:
    for part in path.parts:
        if part.startswith("run-"):
            return part.removeprefix("run-")
    return ""


def load_current_slugs(repo_root: Path) -> dict[str, set[str]]:
    current: dict[str, set[str]] = {}
    for board, relative_path in DATA_FILES.items():
        csv_path = repo_root / relative_path
        slugs: set[str] = set()
        with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            if not reader.fieldnames or "slug" not in reader.fieldnames:
                raise ValueError(f"{csv_path} does not have a slug column")
            for row in reader:
                slug = normalize_slug(row.get("slug", ""))
                if slug:
                    slugs.add(slug)
        current[board] = slugs
    return current


def iter_verified_hit_files(artifact_dir: Path) -> Iterable[Path]:
    yield from artifact_dir.rglob("verified_hits.csv")


def load_discovered(artifact_dir: Path) -> tuple[dict[str, dict[str, Discovery]], Counter[str], int]:
    discovered: dict[str, dict[str, Discovery]] = {board: {} for board in BOARDS}
    files_by_board: Counter[str] = Counter()
    raw_rows = 0

    for csv_path in iter_verified_hit_files(artifact_dir):
        relative_file = str(csv_path.relative_to(artifact_dir))
        run_id = run_id_from_path(csv_path)
        with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                board = row.get("board", "").strip().casefold()
                slug = row.get("slug", "").strip()
                if board not in discovered or not slug:
                    continue
                raw_rows += 1
                files_by_board[board] += 1
                normalized_slug = normalize_slug(slug)
                existing = discovered[board].get(normalized_slug)
                if existing is None:
                    existing = Discovery(
                        board=board,
                        slug=slug,
                        normalized_slug=normalized_slug,
                        api_url=row.get("api_url", "").strip(),
                        board_url=row.get("board_url", "").strip(),
                        source_company_name=row.get("source_company_name", "").strip(),
                        source_dataset=row.get("source_dataset", "").strip(),
                        source_datasets=row.get("source_datasets", "").strip(),
                        source_native_id=row.get("source_native_id", "").strip(),
                        source_country=row.get("source_country", "").strip(),
                        source_jurisdiction=row.get("source_jurisdiction", "").strip(),
                        source_ticker=row.get("source_ticker", "").strip(),
                        source_exchange=row.get("source_exchange", "").strip(),
                        variant_kind=row.get("variant_kind", "").strip(),
                        status=row.get("status", "").strip(),
                        job_count=row.get("job_count", "").strip(),
                        json_shape=row.get("json_shape", "").strip(),
                        first_file=relative_file,
                    )
                    discovered[board][normalized_slug] = existing
                existing.files_seen.add(relative_file)
                if run_id:
                    existing.run_ids_seen.add(run_id)

    return discovered, files_by_board, raw_rows


def write_missing_csv(output_dir: Path, board: str, rows: list[Discovery]) -> Path:
    output_path = output_dir / f"missing_{board}.csv"
    fields = [
        "board",
        "slug",
        "normalized_slug",
        "api_url",
        "board_url",
        "source_company_name",
        "source_dataset",
        "source_datasets",
        "source_native_id",
        "source_country",
        "source_jurisdiction",
        "source_ticker",
        "source_exchange",
        "variant_kind",
        "status",
        "job_count",
        "json_shape",
        "appearances",
        "runs_seen",
        "first_file",
    ]
    with output_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for item in rows:
            writer.writerow(
                {
                    "board": item.board,
                    "slug": item.slug,
                    "normalized_slug": item.normalized_slug,
                    "api_url": item.api_url,
                    "board_url": item.board_url,
                    "source_company_name": item.source_company_name,
                    "source_dataset": item.source_dataset,
                    "source_datasets": item.source_datasets,
                    "source_native_id": item.source_native_id,
                    "source_country": item.source_country,
                    "source_jurisdiction": item.source_jurisdiction,
                    "source_ticker": item.source_ticker,
                    "source_exchange": item.source_exchange,
                    "variant_kind": item.variant_kind,
                    "status": item.status,
                    "job_count": item.job_count,
                    "json_shape": item.json_shape,
                    "appearances": item.appearances,
                    "runs_seen": len(item.run_ids_seen),
                    "first_file": item.first_file,
                }
            )
    return output_path


def write_summary(
    output_dir: Path,
    artifact_dir: Path,
    current: dict[str, set[str]],
    discovered: dict[str, dict[str, Discovery]],
    missing: dict[str, list[Discovery]],
    verified_files: int,
    raw_rows: int,
) -> None:
    summary = {
        "artifact_dir": str(artifact_dir),
        "verified_hit_files": verified_files,
        "raw_verified_rows": raw_rows,
        "boards": {
            board: {
                "current_data_slugs": len(current[board]),
                "unique_discovered_slugs": len(discovered[board]),
                "missing_from_current_data": len(missing[board]),
                "already_present": len(discovered[board]) - len(missing[board]),
            }
            for board in BOARDS
        },
    }

    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    lines = [
        "# Missing Discovered ATS Boards",
        "",
        f"Artifact source: `{artifact_dir}`",
        f"Verified hit files scanned: `{verified_files}`",
        f"Raw verified rows scanned: `{raw_rows}`",
        "",
        "| Board | Current data slugs | Unique discovered slugs | Already present | Missing |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    for board in BOARDS:
        board_summary = summary["boards"][board]
        lines.append(
            "| {board} | {current_data_slugs} | {unique_discovered_slugs} | "
            "{already_present} | {missing_from_current_data} |".format(
                board=board,
                **board_summary,
            )
        )
    lines.append("")
    lines.append("Missing CSV files:")
    for board in BOARDS:
        lines.append(f"- `{output_dir / f'missing_{board}.csv'}`")
    lines.append("")

    (output_dir / "summary.md").write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=repo_root_from_script())
    parser.add_argument("--artifact-dir", type=Path)
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()

    repo_root = args.repo_root.resolve()
    artifact_dir = (args.artifact_dir or latest_artifact_dir(repo_root)).resolve()
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    output_dir = (args.output_dir or repo_root / "reports" / f"missing-discovered-jobboards-{timestamp}").resolve()
    output_dir.mkdir(parents=True, exist_ok=False)

    current = load_current_slugs(repo_root)
    discovered, _files_by_board, raw_rows = load_discovered(artifact_dir)
    verified_files = sum(1 for _ in iter_verified_hit_files(artifact_dir))

    missing: dict[str, list[Discovery]] = {}
    for board in BOARDS:
        missing[board] = sorted(
            (
                item
                for normalized_slug, item in discovered[board].items()
                if normalized_slug not in current[board]
            ),
            key=lambda item: item.normalized_slug,
        )
        write_missing_csv(output_dir, board, missing[board])

    write_summary(output_dir, artifact_dir, current, discovered, missing, verified_files, raw_rows)

    print(f"Report directory: {output_dir}")
    print(f"Verified hit files scanned: {verified_files}")
    print(f"Raw verified rows scanned: {raw_rows}")
    for board in BOARDS:
        already_present = len(discovered[board]) - len(missing[board])
        print(
            f"{board}: discovered={len(discovered[board])} "
            f"current={len(current[board])} present={already_present} missing={len(missing[board])}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
