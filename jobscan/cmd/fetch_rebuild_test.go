package cmd

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"jobscan/internal/db"
)

// A cancelled `fetch --rebuild` must leave the database it was replacing as it
// was. FetchAll stops scheduling boards on cancel and reports no error, so the
// rebuild went on to index the partial database and swap it over the full
// one: a Ctrl+C (or the app's SIGTERM) replaced ~270k jobs with a fraction.

func TestFinishRebuildCancelledKeepsTheDatabaseAndRemovesTheRebuild(t *testing.T) {
	dir := t.TempDir()
	final := filepath.Join(dir, "jobs.db")
	if err := os.WriteFile(final, []byte("the full database"), 0o644); err != nil {
		t.Fatal(err)
	}
	temp := filepath.Join(dir, ".jobs.db.rebuild-20260101000000.tmp")
	sqlDB, err := db.OpenForRebuild(temp)
	if err != nil {
		t.Fatalf("open rebuild db: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err = finishRebuild(ctx, sqlDB, temp, final, true)
	if !errors.Is(err, errFetchCancelled) {
		t.Fatalf("want errFetchCancelled, got %v", err)
	}
	got, _ := os.ReadFile(final)
	if string(got) != "the full database" {
		t.Fatalf("the database was replaced on cancel")
	}
	for _, p := range []string{temp, temp + "-wal", temp + "-shm"} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatalf("rebuild file left behind: %s", filepath.Base(p))
		}
	}
}

func TestFinishRebuildSwapsWhenNotCancelled(t *testing.T) {
	dir := t.TempDir()
	final := filepath.Join(dir, "jobs.db")
	if err := os.WriteFile(final, []byte("the old database"), 0o644); err != nil {
		t.Fatal(err)
	}
	temp := filepath.Join(dir, ".jobs.db.rebuild-20260101000000.tmp")
	sqlDB, err := db.OpenForRebuild(temp)
	if err != nil {
		t.Fatalf("open rebuild db: %v", err)
	}
	if err := finishRebuild(context.Background(), sqlDB, temp, final, true); err != nil {
		t.Fatalf("finish: %v", err)
	}
	got, _ := os.ReadFile(final)
	if string(got) == "the old database" {
		t.Fatalf("the rebuilt database was not swapped in")
	}
	if _, err := os.Stat(temp); !os.IsNotExist(err) {
		t.Fatalf("rebuild file left behind after the swap")
	}
}

func TestCleanStaleRebuildsRemovesOnlyOldLeftovers(t *testing.T) {
	dir := t.TempDir()
	final := filepath.Join(dir, "jobs.db")
	old := filepath.Join(dir, ".jobs.db.rebuild-20250101000000.tmp")
	fresh := filepath.Join(dir, ".jobs.db.rebuild-20260101000000.tmp")
	keep := []string{final, fresh, fresh + "-wal", filepath.Join(dir, "jobs.db.bak-20250101000000")}
	gone := []string{old, old + "-wal", old + "-shm"}
	for _, p := range append(append([]string{}, keep...), gone...) {
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	past := time.Now().Add(-2 * time.Hour)
	for _, p := range gone {
		if err := os.Chtimes(p, past, past); err != nil {
			t.Fatal(err)
		}
	}

	cleanStaleRebuilds(final, 15*time.Minute)

	for _, p := range gone {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatalf("stale rebuild file kept: %s", filepath.Base(p))
		}
	}
	for _, p := range keep {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("removed %s, which is not a stale rebuild", filepath.Base(p))
		}
	}
}
