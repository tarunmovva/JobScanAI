package config

import (
	"os"
	"path/filepath"
)

const (
	DefaultWorkers           = 160
	DefaultGreenhouseWorkers = 240
	DefaultAshbyWorkers      = 160
	DefaultLeverWorkers      = 80
	DefaultMaxAgeHours       = 2
	DefaultLimit             = 25
)

// DefaultPlatformWorkers returns platform-specific fetch concurrency defaults.
func DefaultPlatformWorkers() map[string]int {
	return map[string]int{
		"greenhouse": DefaultGreenhouseWorkers,
		"ashby":      DefaultAshbyWorkers,
		"lever":      DefaultLeverWorkers,
	}
}

// DefaultDBPath returns the default database path.
// Prefer a repo/executable-local jobs.db when the bundled data directory is
// next to the executable; fall back to the current working directory.
func DefaultDBPath() string {
	exe, err := os.Executable()
	if err == nil {
		exeDir := filepath.Dir(exe)
		if _, err := os.Stat(filepath.Join(exeDir, "data")); err == nil {
			return filepath.Join(exeDir, "jobs.db")
		}
	}

	cwd, err := os.Getwd()
	if err == nil {
		return filepath.Join(cwd, "jobs.db")
	}

	return "jobs.db"
}

// DefaultDataDir returns the default data directory (relative to executable).
func DefaultDataDir() string {
	// Try relative to the executable first
	exe, err := os.Executable()
	if err == nil {
		dir := filepath.Join(filepath.Dir(exe), "data")
		if _, err := os.Stat(dir); err == nil {
			return dir
		}
		// Walk up one level (for dev usage)
		dir = filepath.Join(filepath.Dir(filepath.Dir(exe)), "data")
		if _, err := os.Stat(dir); err == nil {
			return dir
		}
	}
	// Fall back to cwd/data
	return "data"
}
