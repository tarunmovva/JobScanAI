#!/bin/bash
# stress_apply.sh - Stress test for the jobscan job application pipeline
# Tests concurrent agent operations: queue → extract → claim → submit
#
# Usage:
#   export JOBSCAN_BIN="path/to/jobscan"  # Optional, defaults to "jobscan"
#   bash tests/stress/stress_apply.sh
#
# Requirements:
#   - jobscan binary (built from Go)
#   - Python 3 (for JSON and database operations)
#   - jobs.db must exist in the main repository root

set -euo pipefail

# ─── Configuration ─────────────────────────────────────────────────────────────

JOBSCAN="${JOBSCAN_BIN:-jobscan}"
JOBS_TO_QUEUE=100
AGENTS=5
export JOB_AUTOMATOR_MOCK=1

# Use Python to handle all path operations for cross-platform compatibility
python << 'PYTHON_MAIN'
import subprocess
import shutil
import sqlite3
import json
import os
import sys
import time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

# Configuration
jobscan_bin = os.environ.get('JOBSCAN_BIN', 'jobscan')
jobs_to_queue = 100
agents = 5
timestamp = int(time.time())

# Determine temp directory
temp_base = None
for candidate in ['/tmp', os.environ.get('TEMP'), os.environ.get('TMP'), '.']:
    if candidate and os.path.isdir(candidate):
        temp_base = candidate
        break

if not temp_base:
    temp_base = '.'

test_db = os.path.join(temp_base, f'stress_apply_test_{timestamp}.db')
payload_dir = os.path.join(temp_base, f'stress_payloads_{timestamp}')
os.makedirs(payload_dir, exist_ok=True)

def log_phase(msg):
    print(f"\n=== {msg} ===")

def log_info(msg):
    print(f"  {msg}")

def log_error(msg):
    print(f"  ERROR: {msg}", file=sys.stderr)

try:
    # ─── Phase 0: Setup ────────────────────────────────────────────────────────────
    log_phase("Phase 0: Setup")

    log_info(f"Python: {sys.version.split()[0]}")
    log_info(f"jobscan: {jobscan_bin}")
    log_info(f"Test database: {test_db}")
    log_info(f"Payload directory: {payload_dir}")

    # Find jobs.db
    default_db = None

    # Try to find from git worktree
    if os.path.isfile('.git'):
        with open('.git') as f:
            gitdir_line = f.read().strip()
            if gitdir_line.startswith('gitdir:'):
                gitdir = gitdir_line.split(':', 1)[1].strip()
                # gitdir is like: <repo>/jobscan/.git/worktrees/apply-pipeline
                # We need: <repo>/jobscan
                # Remove /.git/worktrees/* from the path
                if '/.git/' in gitdir:
                    repo_root = gitdir.split('/.git/')[0]
                else:
                    repo_root = os.path.dirname(os.path.dirname(gitdir))
                jobs_db_candidate = os.path.join(repo_root, 'jobs.db')
                if os.path.isfile(jobs_db_candidate) and os.path.getsize(jobs_db_candidate) > 10_000_000:
                    default_db = jobs_db_candidate

    # Fallback locations
    if not default_db:
        for candidate in ['jobs.db', '../jobs.db', '../../jobs.db']:
            if os.path.isfile(candidate) and os.path.getsize(candidate) > 10_000_000:
                default_db = os.path.abspath(candidate)
                break

    if not default_db:
        log_error("Could not find jobs.db (>10MB) in expected locations")
        sys.exit(1)

    log_info(f"Found jobs.db at: {default_db}")

    # Copy database
    shutil.copy(default_db, test_db)
    log_info("Database copied to test instance")

    # Verify jobs exist
    conn = sqlite3.connect(test_db)
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM jobs;")
    job_count = cursor.fetchone()[0]
    conn.close()

    if job_count == 0:
        log_error("Test database has no jobs")
        sys.exit(1)

    log_info(f"Test database has {job_count} jobs")

    # ─── Phase 1: Queue jobs ───────────────────────────────────────────────────────────
    log_phase("Phase 1: Queue jobs")

    conn = sqlite3.connect(test_db)
    cursor = conn.cursor()
    cursor.execute(f"SELECT id FROM jobs LIMIT {jobs_to_queue};")
    job_ids = [row[0] for row in cursor.fetchall()]
    conn.close()

    if not job_ids:
        log_error("Failed to extract job IDs")
        sys.exit(1)

    log_info(f"Extracted {len(job_ids)} job IDs")
    log_info("Queuing jobs...")

    result = subprocess.run(
        [jobscan_bin, '--db', test_db, 'apply', 'queue', '--job-ids', ','.join(job_ids)],
        capture_output=True,
        text=True
    )

    if result.returncode != 0:
        log_error(f"Queue command failed: {result.stderr}")
        sys.exit(1)

    # Parse queue result
    log_info(result.stdout.strip())

    conn = sqlite3.connect(test_db)
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM applications WHERE status='queued';")
    queued_count = cursor.fetchone()[0]
    conn.close()

    if queued_count == 0:
        log_error("No jobs were queued")
        sys.exit(1)

    log_info(f"Successfully queued: {queued_count} jobs")

    # ─── Phase 2: Extract (mock mode) ──────────────────────────────────────────────────
    log_phase("Phase 2: Extract forms (mock mode)")

    log_info("Running extractors with 3 workers...")
    result = subprocess.run(
        [jobscan_bin, '--db', test_db, 'apply', 'extract', '--workers', '3', '--limit', str(jobs_to_queue)],
        capture_output=True,
        text=True
    )

    if result.returncode != 0:
        log_error(f"Extract command failed: {result.stderr}")
        sys.exit(1)

    log_info(result.stdout.strip())

    # ─── Phase 3: Concurrent agents (claim + submit) ───────────────────────────────────
    log_phase("Phase 3: Concurrent agents claiming and submitting")

    # Create dummy payload
    dummy_payload = os.path.join(payload_dir, 'dummy.json')
    with open(dummy_payload, 'w') as f:
        json.dump({"answers": {"name": "Test User", "email": "test@example.com", "phone": "555-1234"}}, f)

    log_info(f"Starting {agents} agents...")

    def agent_worker(agent_id):
        submitted = 0
        cycles = 0
        while True:
            result = subprocess.run(
                [jobscan_bin, '--db', test_db, 'apply', 'claim',
                 '--count', '5',
                 '--agent-id', f'agent-{agent_id}',
                 '--format', 'json'],
                capture_output=True,
                text=True
            )

            if result.returncode != 0:
                break

            try:
                claims = json.loads(result.stdout)
            except:
                break

            if not isinstance(claims, list) or len(claims) == 0:
                break

            cycles += 1

            # Submit each claim (submit can be slow in mock mode)
            for claim in claims:
                token = claim.get('claim_token', '')
                if token:
                    try:
                        subprocess.run(
                            [jobscan_bin, '--db', test_db, 'apply', 'submit',
                             '--claim-token', token,
                             '--payload-file', dummy_payload],
                            capture_output=True,
                            timeout=60
                        )
                        submitted += 1
                    except subprocess.TimeoutExpired:
                        # Submit may be slow; just continue
                        pass
                    except Exception:
                        pass

        return f"agent-{agent_id}: {cycles} cycles, {submitted} submitted"

    # Run agents in parallel
    with ThreadPoolExecutor(max_workers=agents) as executor:
        futures = [executor.submit(agent_worker, i) for i in range(1, agents + 1)]
        for future in as_completed(futures):
            try:
                log_info(future.result())
            except Exception as e:
                log_error(f"Agent error: {e}")

    log_info("All agents finished")

    # ─── Phase 4: Verification ────────────────────────────────────────────────────────
    log_phase("Phase 4: Verification")

    result = subprocess.run(
        [jobscan_bin, '--db', test_db, 'apply', 'status', '--format', 'json'],
        capture_output=True,
        text=True
    )

    try:
        status = json.loads(result.stdout)
        print(json.dumps(status, indent=2))
    except:
        log_error("Could not parse status JSON")
        sys.exit(1)

    submitted = status.get('submitted', 0)
    failed = status.get('failed', 0)
    total = submitted + failed

    log_info("Final status:")
    log_info(f"  Submitted: {submitted}")
    log_info(f"  Failed: {failed}")
    log_info(f"  Total terminal: {total} / {jobs_to_queue}")

    # ─── Result ────────────────────────────────────────────────────────────────────────
    log_phase("Test Result")

    if total == jobs_to_queue:
        log_info(f"PASS: All {jobs_to_queue} jobs reached terminal state")
        print("\nStress test PASSED")
        sys.exit(0)
    else:
        log_error(f"FAIL: Only {total} / {jobs_to_queue} reached terminal state")
        print("\nStress test FAILED")
        sys.exit(1)

finally:
    # Cleanup
    try:
        import shutil
        if os.path.exists(test_db):
            os.remove(test_db)
        if os.path.exists(f"{test_db}-wal"):
            os.remove(f"{test_db}-wal")
        if os.path.exists(f"{test_db}-shm"):
            os.remove(f"{test_db}-shm")
        if os.path.exists(payload_dir):
            shutil.rmtree(payload_dir)
    except:
        pass

PYTHON_MAIN
