#!/usr/bin/env python3
"""Append validated discovered ATS board slugs to jobscan data CSVs.

Inputs come from the latest validate-discovered-links report. Existing data
rows are preserved, existing slugs are skipped by case-insensitive normalized
slug, and only links that returned 2xx are appended.
"""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


BOARDS = ("ashby", "greenhouse", "lever")
DATA_FILES = {
    "ashby": "data/finalworkingjobboardname_ashby.csv",
    "greenhouse": "data/finalworkingjobboardname_greenhouse.csv",
    "lever": "data/finalworkingjobboardname_lever.csv",
}
REQUIRED_FIELDS = ("slug", "working_url", "status_code", "error")


@dataclass(frozen=True)
class Addition:
    board: str
    slug: str
    working_url: str
    status_code: str
    source_company_name: str
    source_dataset: str
    source_native_id: str


def normalize_slug(value: str) -> str:
    return value.strip().casefold()


def repo_root_from_script() -> Path:
    return Path(__file__).resolve().parents[1]


def latest_validation_report(repo_root: Path) -> Path:
    base = repo_root / "reports"
    candidates = sorted(
        (path for path in base.glob("validate-discovered-links-*") if path.is_dir()),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    if not candidates:
        raise FileNotFoundError(f"No validate-discovered-links report found in {base}")
    return candidates[0]


def load_current_rows(csv_path: Path) -> tuple[list[str], list[dict[str, str]], Counter[str]]:
    with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames:
            raise ValueError(f"{csv_path} has no header")
        missing = [field for field in REQUIRED_FIELDS if field not in reader.fieldnames]
        if missing:
            raise ValueError(f"{csv_path} missing required fields: {', '.join(missing)}")
        rows = list(reader)

    normalized_counts: Counter[str] = Counter()
    for row in rows:
        slug = normalize_slug(row.get("slug", ""))
        if slug:
            normalized_counts[slug] += 1

    return list(reader.fieldnames), rows, normalized_counts


def load_validated_additions(validation_csv: Path) -> dict[str, dict[str, Addition]]:
    additions: dict[str, dict[str, Addition]] = {board: {} for board in BOARDS}
    duplicate_candidates: defaultdict[tuple[str, str], int] = defaultdict(int)
    with validation_csv.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            board = row.get("board", "").strip().casefold()
            slug = row.get("slug", "").strip()
            if board not in additions or not slug:
                continue
            if row.get("ok_2xx", "").strip().casefold() != "true":
                continue
            normalized_slug = normalize_slug(slug)
            duplicate_candidates[(board, normalized_slug)] += 1
            additions[board].setdefault(
                normalized_slug,
                Addition(
                    board=board,
                    slug=slug,
                    working_url=row.get("url", "").strip() or row.get("api_url", "").strip(),
                    status_code=row.get("status_code", "").strip(),
                    source_company_name=row.get("source_company_name", "").strip(),
                    source_dataset=row.get("source_dataset", "").strip(),
                    source_native_id=row.get("source_native_id", "").strip(),
                ),
            )

    duplicated = {key: count for key, count in duplicate_candidates.items() if count > 1}
    if duplicated:
        examples = ", ".join(f"{board}:{slug}={count}" for (board, slug), count in list(duplicated.items())[:10])
        raise ValueError(f"validation report has duplicate 2xx candidates after normalization: {examples}")
    return additions


def write_rows(csv_path: Path, fieldnames: list[str], rows: list[dict[str, str]]) -> None:
    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def write_additions_report(output_dir: Path, board: str, additions: list[Addition]) -> None:
    fields = [
        "board",
        "slug",
        "working_url",
        "status_code",
        "source_company_name",
        "source_dataset",
        "source_native_id",
    ]
    with (output_dir / f"added_{board}.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, lineterminator="\n")
        writer.writeheader()
        for item in additions:
            writer.writerow(
                {
                    "board": item.board,
                    "slug": item.slug,
                    "working_url": item.working_url,
                    "status_code": item.status_code,
                    "source_company_name": item.source_company_name,
                    "source_dataset": item.source_dataset,
                    "source_native_id": item.source_native_id,
                }
            )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=repo_root_from_script())
    parser.add_argument("--validation-report-dir", type=Path)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    repo_root = args.repo_root.resolve()
    validation_report_dir = (args.validation_report_dir or latest_validation_report(repo_root)).resolve()
    validation_csv = validation_report_dir / "all_discovered_link_status.csv"
    if not validation_csv.exists():
        raise FileNotFoundError(f"Missing validation CSV: {validation_csv}")

    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    output_dir = (args.output_dir or repo_root / "reports" / f"add-discovered-jobboards-{timestamp}").resolve()
    output_dir.mkdir(parents=True, exist_ok=False)

    validated = load_validated_additions(validation_csv)
    summary: dict[str, object] = {
        "validation_report_dir": str(validation_report_dir),
        "dry_run": args.dry_run,
        "boards": {},
    }

    total_added = 0
    for board in BOARDS:
        csv_path = repo_root / DATA_FILES[board]
        fieldnames, rows, existing_counts = load_current_rows(csv_path)
        existing_duplicate_slugs = {slug: count for slug, count in existing_counts.items() if count > 1}

        existing = set(existing_counts)
        board_additions = [
            item for slug, item in sorted(validated[board].items()) if slug not in existing
        ]
        skipped_present = len(validated[board]) - len(board_additions)

        new_rows = rows + [
            {
                "slug": item.slug,
                "working_url": item.working_url,
                "status_code": item.status_code or "200",
                "error": "",
            }
            for item in board_additions
        ]

        post_counts: Counter[str] = Counter()
        for row in new_rows:
            slug = normalize_slug(row.get("slug", ""))
            if slug:
                post_counts[slug] += 1
        post_duplicates = {slug: count for slug, count in post_counts.items() if count > 1}
        introduced_duplicates = {
            slug: count
            for slug, count in post_duplicates.items()
            if existing_counts.get(slug, 0) != count
        }
        if introduced_duplicates:
            examples = ", ".join(f"{slug}={count}" for slug, count in list(introduced_duplicates.items())[:10])
            raise ValueError(f"merge would create normalized duplicate slugs in {csv_path}: {examples}")

        if not args.dry_run and board_additions:
            write_rows(csv_path, fieldnames, new_rows)
        write_additions_report(output_dir, board, board_additions)

        total_added += len(board_additions)
        summary["boards"][board] = {
            "data_file": str(csv_path),
            "before_rows": len(rows),
            "validated_2xx_unique": len(validated[board]),
            "already_present_skipped": skipped_present,
            "added": len(board_additions),
            "after_rows": len(new_rows),
            "existing_normalized_duplicate_slugs": len(existing_duplicate_slugs),
            "post_merge_duplicate_slugs": len(post_duplicates),
            "duplicate_slugs_introduced": len(introduced_duplicates),
        }

    summary["total_added"] = total_added
    (output_dir / "summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    lines = [
        "# Add Discovered Job Boards",
        "",
        f"Validation report: `{validation_report_dir}`",
        f"Dry run: `{args.dry_run}`",
        f"Total added: `{total_added}`",
        "",
        "| Board | Before rows | Validated 2xx unique | Already present skipped | Added | After rows | Existing duplicate slugs | Duplicate slugs introduced |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    boards_summary = summary["boards"]
    assert isinstance(boards_summary, dict)
    for board in BOARDS:
        item = boards_summary[board]
        lines.append(
            "| {board} | {before_rows} | {validated_2xx_unique} | {already_present_skipped} | "
            "{added} | {after_rows} | {existing_normalized_duplicate_slugs} | "
            "{duplicate_slugs_introduced} |".format(board=board, **item)
        )
    lines.append("")
    lines.append("Added-row CSV reports:")
    for board in BOARDS:
        lines.append(f"- `{output_dir / f'added_{board}.csv'}`")
    lines.append("")
    (output_dir / "summary.md").write_text("\n".join(lines), encoding="utf-8")

    print(f"Report directory: {output_dir}")
    print(f"Total added: {total_added}")
    for board in BOARDS:
        item = boards_summary[board]
        print(
            f"{board}: before={item['before_rows']} added={item['added']} "
            f"after={item['after_rows']} skipped_present={item['already_present_skipped']} "
            f"existing_duplicate_slugs={item['existing_normalized_duplicate_slugs']} "
            f"introduced_duplicates={item['duplicate_slugs_introduced']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
