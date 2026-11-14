#!/usr/bin/env python3
"""Validate discovered ATS API links and write a status report.

The script reads downloaded GitHub Actions artifacts, de-dupes discovered
verified hits by ATS board and slug, calls each API URL with GET, and reports
whether the response status is 2xx.
"""

from __future__ import annotations

import argparse
import csv
import json
import socket
import ssl
import time
import urllib.error
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path


BOARDS = ("ashby", "greenhouse", "lever")
DATA_FILES = {
    "ashby": "data/finalworkingjobboardname_ashby.csv",
    "greenhouse": "data/finalworkingjobboardname_greenhouse.csv",
    "lever": "data/finalworkingjobboardname_lever.csv",
}
USER_AGENT = "jobscan-link-validator/1.0"


@dataclass
class Link:
    board: str
    slug: str
    normalized_slug: str
    api_url: str
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
    artifact_status: str = ""
    artifact_job_count: str = ""
    artifact_json_shape: str = ""
    first_file: str = ""
    files_seen: set[str] = field(default_factory=set)
    run_ids_seen: set[str] = field(default_factory=set)
    in_current_data: bool = False

    @property
    def url(self) -> str:
        return self.api_url or self.board_url

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


def iter_verified_hit_files(artifact_dir: Path):
    yield from artifact_dir.rglob("verified_hits.csv")


def load_links(artifact_dir: Path, current: dict[str, set[str]]) -> dict[tuple[str, str], Link]:
    links: dict[tuple[str, str], Link] = {}
    for csv_path in iter_verified_hit_files(artifact_dir):
        relative_file = str(csv_path.relative_to(artifact_dir))
        run_id = run_id_from_path(csv_path)
        with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                board = row.get("board", "").strip().casefold()
                slug = row.get("slug", "").strip()
                if board not in BOARDS or not slug:
                    continue
                normalized_slug = normalize_slug(slug)
                key = (board, normalized_slug)
                item = links.get(key)
                if item is None:
                    item = Link(
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
                        artifact_status=row.get("status", "").strip(),
                        artifact_job_count=row.get("job_count", "").strip(),
                        artifact_json_shape=row.get("json_shape", "").strip(),
                        first_file=relative_file,
                        in_current_data=normalized_slug in current[board],
                    )
                    links[key] = item
                item.files_seen.add(relative_file)
                if run_id:
                    item.run_ids_seen.add(run_id)
    return links


def call_url(link: Link, timeout: float) -> dict[str, object]:
    started = time.perf_counter()
    request = urllib.request.Request(
        link.url,
        method="GET",
        headers={"User-Agent": USER_AGENT, "Accept": "application/json,*/*;q=0.8"},
    )
    status_code = None
    final_url = ""
    error = ""
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status_code = response.getcode()
            final_url = response.geturl()
    except urllib.error.HTTPError as exc:
        status_code = exc.code
        final_url = exc.url or ""
        error = f"HTTPError: {exc.reason}"
    except urllib.error.URLError as exc:
        error = f"URLError: {exc.reason}"
    except socket.timeout:
        error = "timeout"
    except ssl.SSLError as exc:
        error = f"SSLError: {exc}"
    except Exception as exc:  # noqa: BLE001 - report unexpected network errors.
        error = f"{type(exc).__name__}: {exc}"
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    ok_2xx = bool(status_code is not None and 200 <= status_code <= 299)
    return {
        "board": link.board,
        "slug": link.slug,
        "normalized_slug": link.normalized_slug,
        "url": link.url,
        "api_url": link.api_url,
        "board_url": link.board_url,
        "in_current_data": link.in_current_data,
        "status_code": status_code,
        "ok_2xx": ok_2xx,
        "error": error,
        "elapsed_ms": elapsed_ms,
        "final_url": final_url,
        "source_company_name": link.source_company_name,
        "source_dataset": link.source_dataset,
        "source_datasets": link.source_datasets,
        "source_native_id": link.source_native_id,
        "source_country": link.source_country,
        "source_jurisdiction": link.source_jurisdiction,
        "source_ticker": link.source_ticker,
        "source_exchange": link.source_exchange,
        "variant_kind": link.variant_kind,
        "artifact_status": link.artifact_status,
        "artifact_job_count": link.artifact_job_count,
        "artifact_json_shape": link.artifact_json_shape,
        "appearances": link.appearances,
        "runs_seen": len(link.run_ids_seen),
        "first_file": link.first_file,
    }


def write_csv(path: Path, rows: list[dict[str, object]]) -> None:
    fields = [
        "board",
        "slug",
        "normalized_slug",
        "url",
        "api_url",
        "board_url",
        "in_current_data",
        "status_code",
        "ok_2xx",
        "error",
        "elapsed_ms",
        "final_url",
        "source_company_name",
        "source_dataset",
        "source_datasets",
        "source_native_id",
        "source_country",
        "source_jurisdiction",
        "source_ticker",
        "source_exchange",
        "variant_kind",
        "artifact_status",
        "artifact_job_count",
        "artifact_json_shape",
        "appearances",
        "runs_seen",
        "first_file",
    ]
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def summarize(rows: list[dict[str, object]], artifact_dir: Path, elapsed_seconds: float) -> dict[str, object]:
    by_board: dict[str, dict[str, int]] = {}
    by_status: Counter[str] = Counter()
    for row in rows:
        board = str(row["board"])
        status_key = str(row["status_code"] or "error")
        by_status[status_key] += 1
        board_summary = by_board.setdefault(
            board,
            {
                "total": 0,
                "ok_2xx": 0,
                "non_2xx": 0,
                "errors": 0,
                "in_current_data": 0,
                "missing_from_current_data": 0,
            },
        )
        board_summary["total"] += 1
        if row["ok_2xx"]:
            board_summary["ok_2xx"] += 1
        elif row["status_code"]:
            board_summary["non_2xx"] += 1
        else:
            board_summary["errors"] += 1
        if row["in_current_data"]:
            board_summary["in_current_data"] += 1
        else:
            board_summary["missing_from_current_data"] += 1

    total = len(rows)
    ok_total = sum(1 for row in rows if row["ok_2xx"])
    status_counts = {key: by_status[key] for key in sorted(by_status, key=lambda item: (item == "error", item))}
    return {
        "artifact_dir": str(artifact_dir),
        "total_links": total,
        "ok_2xx": ok_total,
        "not_2xx_or_error": total - ok_total,
        "elapsed_seconds": round(elapsed_seconds, 2),
        "boards": by_board,
        "status_counts": status_counts,
    }


def write_markdown(path: Path, summary: dict[str, object]) -> None:
    lines = [
        "# Discovered ATS Link Validation",
        "",
        f"Artifact source: `{summary['artifact_dir']}`",
        f"Total unique links tested: `{summary['total_links']}`",
        f"2xx responses: `{summary['ok_2xx']}`",
        f"Not 2xx or network error: `{summary['not_2xx_or_error']}`",
        f"Elapsed seconds: `{summary['elapsed_seconds']}`",
        "",
        "| Board | Total | 2xx | Non-2xx | Network errors | In current data | Missing from current data |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    boards = summary["boards"]
    assert isinstance(boards, dict)
    for board in BOARDS:
        board_summary = boards.get(board, {})
        lines.append(
            "| {board} | {total} | {ok_2xx} | {non_2xx} | {errors} | {in_current_data} | "
            "{missing_from_current_data} |".format(
                board=board,
                total=board_summary.get("total", 0),
                ok_2xx=board_summary.get("ok_2xx", 0),
                non_2xx=board_summary.get("non_2xx", 0),
                errors=board_summary.get("errors", 0),
                in_current_data=board_summary.get("in_current_data", 0),
                missing_from_current_data=board_summary.get("missing_from_current_data", 0),
            )
        )
    lines.extend(["", "Status counts:"])
    status_counts = summary["status_counts"]
    assert isinstance(status_counts, dict)
    for status, count in status_counts.items():
        lines.append(f"- `{status}`: `{count}`")
    lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=repo_root_from_script())
    parser.add_argument("--artifact-dir", type=Path)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--concurrency", type=int, default=24)
    parser.add_argument("--timeout", type=float, default=20.0)
    args = parser.parse_args()

    repo_root = args.repo_root.resolve()
    artifact_dir = (args.artifact_dir or latest_artifact_dir(repo_root)).resolve()
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    output_dir = (args.output_dir or repo_root / "reports" / f"validate-discovered-links-{timestamp}").resolve()
    output_dir.mkdir(parents=True, exist_ok=False)

    current = load_current_slugs(repo_root)
    links = load_links(artifact_dir, current)
    ordered_links = [links[key] for key in sorted(links)]
    results: list[dict[str, object]] = []

    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=max(1, args.concurrency)) as executor:
        future_to_link = {executor.submit(call_url, link, args.timeout): link for link in ordered_links}
        completed = 0
        for future in as_completed(future_to_link):
            completed += 1
            results.append(future.result())
            if completed % 100 == 0 or completed == len(ordered_links):
                print(f"validated {completed}/{len(ordered_links)}")

    results.sort(key=lambda row: (str(row["board"]), str(row["normalized_slug"])))
    elapsed_seconds = time.perf_counter() - started
    failures = [row for row in results if not row["ok_2xx"]]

    write_csv(output_dir / "all_discovered_link_status.csv", results)
    write_csv(output_dir / "not_2xx_or_error.csv", failures)

    summary = summarize(results, artifact_dir, elapsed_seconds)
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    write_markdown(output_dir / "summary.md", summary)

    print(f"Report directory: {output_dir}")
    print(f"Total unique links tested: {summary['total_links']}")
    print(f"2xx responses: {summary['ok_2xx']}")
    print(f"Not 2xx or error: {summary['not_2xx_or_error']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
