package db

import (
	"testing"

	"jobscan/internal/model"
)

func TestNormalizeTermStripsOnlyHyphens(t *testing.T) {
	cases := map[string]string{
		"full-stack": "fullstack",
		"Full-Stack": "fullstack",
		"back-end":   "backend",
		// '.', '+' and '#' must survive: stripping them would collapse .NET
		// onto "net" and both C++ and C# onto "c".
		".net": ".net",
		"c++":  "c++",
		"c#":   "c#",
	}
	for in, want := range cases {
		if got := normalizeTerm(in); got != want {
			t.Errorf("normalizeTerm(%q) = %q, want %q", in, got, want)
		}
	}
}

// A nil expander is the state of any database that predates the term index, and
// of --no-expand. It must behave exactly as before, not panic.
func TestNilExpanderIsInert(t *testing.T) {
	var e *TermExpander
	if got := e.Variants("fullstack"); len(got) != 1 || got[0] != "fullstack" {
		t.Fatalf("Variants on nil expander = %v, want [fullstack]", got)
	}
	e.Close()
}

func job(slug, name, title string) model.Job {
	return model.Job{CompanySlug: slug, CompanyName: name, Title: title}
}

func titles(jobs []model.Job) []string {
	out := make([]string, len(jobs))
	for i, j := range jobs {
		out[i] = j.CompanySlug + "/" + j.Title
	}
	return out
}

func TestDedupeCollapsesOnlyPresentationDifferences(t *testing.T) {
	in := []model.Job{
		job("acme", "Acme", "Software Engineer"),
		job("acme", "Acme", "software  engineer"), // same role, different casing
		job("acme", "Acme", "Software Engineer II"),
		job("beta", "Beta", "Software Engineer"), // different company
	}
	got := diversify(in, model.SearchParams{Dedupe: true}, 10)
	if len(got) != 3 {
		t.Fatalf("diversify() kept %d jobs (%v), want 3", len(got), titles(got))
	}
	if got[1].Title != "Software Engineer II" {
		t.Errorf("a level suffix is a different role and must survive: %v", titles(got))
	}
}

func TestMaxPerCompanyKeepsTheBestRanked(t *testing.T) {
	in := []model.Job{
		job("acme", "acme", "Engineer A"),
		job("acme", "acme", "Engineer B"),
		job("acme", "acme", "Engineer C"),
		job("other", "Other", "Engineer D"),
	}
	got := diversify(in, model.SearchParams{MaxPerCompany: 2}, 10)
	if len(got) != 3 {
		t.Fatalf("diversify() kept %d (%v), want 3", len(got), titles(got))
	}
	if got[0].Title != "Engineer A" || got[1].Title != "Engineer B" {
		t.Errorf("cap must keep the highest-ranked rows, got %v", titles(got))
	}
}

// A source with no slug must not become one unbounded bucket keyed on "".
func TestMaxPerCompanyFallsBackToDisplayName(t *testing.T) {
	in := []model.Job{
		job("", "Acme", "A"), job("", "Acme", "B"), job("", "Beta", "C"),
	}
	got := diversify(in, model.SearchParams{MaxPerCompany: 1}, 10)
	if len(got) != 2 {
		t.Fatalf("diversify() kept %d (%v), want 2", len(got), titles(got))
	}
}

// The filters discard rows, so SearchJobs over-fetches. diversify is what trims
// back to the caller's limit -- if it did not, callers would get 4x what they
// asked for.
func TestDiversifyTrimsToLimit(t *testing.T) {
	var in []model.Job
	for i := 0; i < 40; i++ {
		in = append(in, job(string(rune('a'+i%26))+"co", "Co", "Engineer "+string(rune('a'+i))))
	}
	if got := diversify(in, model.SearchParams{Dedupe: true}, 10); len(got) != 10 {
		t.Fatalf("diversify() returned %d, want 10", len(got))
	}
	// With no filter requested it must still respect the limit.
	if got := diversify(in, model.SearchParams{}, 10); len(got) != 10 {
		t.Fatalf("diversify() with no filter returned %d, want 10", len(got))
	}
}
