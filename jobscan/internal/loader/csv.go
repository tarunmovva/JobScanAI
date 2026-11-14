package loader

import (
	"encoding/csv"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// PlatformSlugs holds the list of company slugs for each platform.
type PlatformSlugs struct {
	Greenhouse []string
	Lever      []string
	Ashby      []string
}

// LoadFromDir reads all three CSV files from the given data directory.
func LoadFromDir(dataDir string) (*PlatformSlugs, error) {
	ps := &PlatformSlugs{}
	var err error

	ps.Greenhouse, err = loadCSV(filepath.Join(dataDir, "finalworkingjobboardname_greenhouse.csv"))
	if err != nil {
		return nil, fmt.Errorf("loading greenhouse CSV: %w", err)
	}

	ps.Lever, err = loadCSV(filepath.Join(dataDir, "finalworkingjobboardname_lever.csv"))
	if err != nil {
		return nil, fmt.Errorf("loading lever CSV: %w", err)
	}

	ps.Ashby, err = loadCSV(filepath.Join(dataDir, "finalworkingjobboardname_ashby.csv"))
	if err != nil {
		return nil, fmt.Errorf("loading ashby CSV: %w", err)
	}

	return ps, nil
}

// FilterBySlugs returns only the slugs matching the given filter list.
// If filter is empty, returns all slugs.
func (ps *PlatformSlugs) FilterBySlugs(filter []string) *PlatformSlugs {
	if len(filter) == 0 {
		return ps
	}
	want := make(map[string]bool, len(filter))
	for _, s := range filter {
		want[strings.ToLower(strings.TrimSpace(s))] = true
	}
	return &PlatformSlugs{
		Greenhouse: filterSlice(ps.Greenhouse, want),
		Lever:      filterSlice(ps.Lever, want),
		Ashby:      filterSlice(ps.Ashby, want),
	}
}

// FilterByPlatforms returns only the platforms in the given list.
// If filter is empty, returns all platforms (unchanged).
func (ps *PlatformSlugs) FilterByPlatforms(platforms []string) *PlatformSlugs {
	if len(platforms) == 0 {
		return ps
	}
	want := make(map[string]bool, len(platforms))
	for _, p := range platforms {
		want[strings.ToLower(strings.TrimSpace(p))] = true
	}
	result := &PlatformSlugs{}
	if want["greenhouse"] {
		result.Greenhouse = ps.Greenhouse
	}
	if want["lever"] {
		result.Lever = ps.Lever
	}
	if want["ashby"] {
		result.Ashby = ps.Ashby
	}
	return result
}

func filterSlice(slugs []string, want map[string]bool) []string {
	out := make([]string, 0)
	for _, s := range slugs {
		if want[strings.ToLower(s)] {
			out = append(out, s)
		}
	}
	return out
}

func loadCSV(path string) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("CSV file not found: %s", path)
		}
		return nil, err
	}
	defer f.Close()

	r := csv.NewReader(f)
	r.ReuseRecord = true // performance: reuse the slice
	
	// Read header
	header, err := r.Read()
	if err != nil {
		return nil, fmt.Errorf("reading CSV header: %w", err)
	}

	// Find slug column index
	slugIdx := -1
	for i, h := range header {
		if strings.TrimSpace(strings.ToLower(h)) == "slug" {
			slugIdx = i
			break
		}
	}
	if slugIdx == -1 {
		return nil, fmt.Errorf("no 'slug' column in %s", path)
	}

	var slugs []string
	seen := make(map[string]bool, 6000)
	for {
		record, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			continue // skip malformed rows
		}
		if slugIdx >= len(record) {
			continue
		}
		slug := strings.TrimSpace(strings.Trim(record[slugIdx], `"`))
		if slug != "" && !seen[slug] {
			seen[slug] = true
			slugs = append(slugs, slug)
		}
	}
	return slugs, nil
}
