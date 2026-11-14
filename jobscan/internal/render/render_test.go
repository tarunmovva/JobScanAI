package render

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"jobscan/internal/model"
)

func TestJSONRendersStableFields(t *testing.T) {
	var buf bytes.Buffer

	jobs := []model.Job{
		{
			ID:               "id-1",
			JobID:            "job-1",
			CompanySlug:      "acme",
			CompanyName:      "Acme Corp",
			Title:            "Software Engineer",
			Location:         "Austin, TX",
			WorkplaceType:    "Remote",
			EmploymentType:   "Full-Time",
			Department:       "Engineering",
			Team:             "Platform",
			Country:          "United States",
			PostedAt:         "2026-04-26T12:00:00Z",
			Platform:         "greenhouse",
			JobURL:           "https://example.com/job",
			ApplyURL:         "https://example.com/apply",
			DescriptionPlain: "distributed systems",
		},
	}

	if err := JSON(&buf, jobs); err != nil {
		t.Fatalf("JSON() error = %v", err)
	}

	var decoded []map[string]interface{}
	if err := json.Unmarshal(buf.Bytes(), &decoded); err != nil {
		t.Fatalf("rendered JSON is invalid: %v\n%s", err, buf.String())
	}
	if len(decoded) != 1 {
		t.Fatalf("decoded length = %d, want 1", len(decoded))
	}

	row := decoded[0]
	assertJSONField(t, row, "id", "id-1")
	assertJSONField(t, row, "job_id", "job-1")
	assertJSONField(t, row, "company", "Acme Corp")
	assertJSONField(t, row, "title", "Software Engineer")
	assertJSONField(t, row, "posted_at", "2026-04-26")
	assertJSONField(t, row, "description", "distributed systems")
}

func TestJSONOmitsEmptyOptionalFields(t *testing.T) {
	var buf bytes.Buffer

	if err := JSON(&buf, []model.Job{{ID: "id-1", CompanySlug: "acme", Title: "Software Engineer", Platform: "lever"}}); err != nil {
		t.Fatalf("JSON() error = %v", err)
	}

	var decoded []map[string]interface{}
	if err := json.Unmarshal(buf.Bytes(), &decoded); err != nil {
		t.Fatalf("rendered JSON is invalid: %v", err)
	}

	if _, ok := decoded[0]["workplace_type"]; ok {
		t.Fatalf("workplace_type should be omitted when empty: %v", decoded[0])
	}
	assertJSONField(t, decoded[0], "company", "acme")
}

func TestCSVRendersHeaderAndEscapedRows(t *testing.T) {
	var buf bytes.Buffer

	jobs := []model.Job{
		{
			CompanyName:    "Acme, Inc.",
			Title:          "Software Engineer\nPlatform",
			Location:       "Austin, TX",
			WorkplaceType:  "Remote",
			EmploymentType: "Full-Time",
			Department:     "Engineering",
			Team:           "Platform",
			Country:        "United States",
			PostedAt:       "2026-04-26T12:00:00Z",
			Platform:       "greenhouse",
			JobURL:         "https://example.com/job",
			ApplyURL:       "https://example.com/apply",
			SalaryRaw:      "$100,000",
		},
	}

	if err := CSV(&buf, jobs); err != nil {
		t.Fatalf("CSV() error = %v", err)
	}

	rows, err := csv.NewReader(strings.NewReader(buf.String())).ReadAll()
	if err != nil {
		t.Fatalf("rendered CSV is invalid: %v\n%s", err, buf.String())
	}
	if len(rows) != 2 {
		t.Fatalf("CSV row count = %d, want 2", len(rows))
	}

	wantHeader := []string{"Company", "Title", "Location", "WorkplaceType", "EmploymentType", "Department", "Team", "Country", "PostedAt", "Platform", "JobURL", "ApplyURL", "Salary"}
	for i, want := range wantHeader {
		if rows[0][i] != want {
			t.Fatalf("header[%d] = %q, want %q", i, rows[0][i], want)
		}
	}
	if rows[1][0] != "Acme, Inc." || rows[1][1] != "Software Engineer\nPlatform" || rows[1][8] != "2026-04-26" {
		t.Fatalf("unexpected CSV row: %v", rows[1])
	}
}

func TestTableNoRows(t *testing.T) {
	var buf bytes.Buffer
	Table(&buf, nil, 0, time.Millisecond)
	if !strings.Contains(buf.String(), "No results found") {
		t.Fatalf("Table() output = %q", buf.String())
	}
}

func TestTableUnknownTotal(t *testing.T) {
	var buf bytes.Buffer
	Table(&buf, []model.Job{{
		CompanySlug: "acme",
		Title:       "Software Engineer",
		Platform:    "greenhouse",
		JobURL:      "https://example.com/job",
	}}, -1, time.Millisecond)

	out := buf.String()
	if !strings.Contains(out, "Showing 1 results") {
		t.Fatalf("Table() output = %q, want unknown-total summary", out)
	}
	if strings.Contains(out, "Showing 1 of") {
		t.Fatalf("Table() output = %q, should not render counted summary", out)
	}
}

func assertJSONField(t *testing.T, row map[string]interface{}, key, want string) {
	t.Helper()

	got, ok := row[key]
	if !ok {
		t.Fatalf("missing JSON field %q in %v", key, row)
	}
	if got != want {
		t.Fatalf("JSON field %q = %q, want %q", key, got, want)
	}
}
