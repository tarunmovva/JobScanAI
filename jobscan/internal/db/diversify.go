package db

import (
	"strings"
	"unicode"

	"jobscan/internal/model"
)

// A ranked page of results is not the same thing as a page of USEFUL results.
// Measured on three representative top-100 slices from this database:
//
//	title backbone   74 distinct companies, 15 slots on repeated title+company
//	systems stack    71 distinct companies, 14 slots
//	infra stack      59 distinct companies, 18 slots -- one employer took 19
//
// So 14-18% of every slice went to postings the caller had already seen, and a
// single company could take a fifth of it. Both filters are opt-in: for a
// general search tool, four cities hiring the same title really are four
// distinct openings. For a caller building a candidate pool they are one.

// diversityOverFetch is how much extra SQL is asked for when a filter will
// discard rows. Four covers the worst observed case (19 of 100 from one
// company) with room to spare.
const diversityOverFetch = 4

func diversityRequested(params model.SearchParams) bool {
	return params.Dedupe || params.MaxPerCompany > 0
}

// dedupeKey collapses only presentation differences -- case, punctuation,
// runs of whitespace. "Software Engineer" and "Software Engineer II" stay
// distinct, because they are.
func dedupeKey(job model.Job) string {
	var b strings.Builder
	prevSpace := false
	for _, r := range strings.ToLower(job.Title) {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r) || r == '+' || r == '#':
			b.WriteRune(r)
			prevSpace = false
		case !prevSpace:
			b.WriteRune(' ')
			prevSpace = true
		}
	}
	return strings.ToLower(strings.TrimSpace(job.CompanySlug)) + "|" + strings.TrimSpace(b.String())
}

// diversify keeps rank order and returns at most limit jobs.
func diversify(jobs []model.Job, params model.SearchParams, limit int) []model.Job {
	if !diversityRequested(params) {
		if limit > 0 && len(jobs) > limit {
			return jobs[:limit]
		}
		return jobs
	}

	seen := make(map[string]bool, len(jobs))
	perCompany := make(map[string]int, len(jobs))
	out := make([]model.Job, 0, len(jobs))
	for _, job := range jobs {
		if params.Dedupe {
			key := dedupeKey(job)
			if seen[key] {
				continue
			}
			seen[key] = true
		}
		if params.MaxPerCompany > 0 {
			// Fall back to the display name so a source with no slug does not
			// become one unbounded bucket keyed on "".
			company := strings.ToLower(strings.TrimSpace(job.CompanySlug))
			if company == "" {
				company = strings.ToLower(strings.TrimSpace(job.CompanyName))
			}
			if perCompany[company] >= params.MaxPerCompany {
				continue
			}
			perCompany[company]++
		}
		out = append(out, job)
		if limit > 0 && len(out) >= limit {
			break
		}
	}
	return out
}
