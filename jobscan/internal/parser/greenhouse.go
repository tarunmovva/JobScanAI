package parser

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"jobscan/internal/model"
	"jobscan/internal/normalize"
)

// GreenhouseResponse is the top-level API response.
type GreenhouseResponse struct {
	Jobs []GreenhouseJob `json:"jobs"`
}

// GreenhouseJob is a single job from the Greenhouse API.
type GreenhouseJob struct {
	ID           int64  `json:"id"`
	Title        string `json:"title"`
	CompanyName  string `json:"company_name"`
	AbsoluteURL  string `json:"absolute_url"`
	Location     struct {
		Name string `json:"name"`
	} `json:"location"`
	Metadata     json.RawMessage `json:"metadata"` // can be null
	UpdatedAt    string          `json:"updated_at"`
	FirstPublished string        `json:"first_published"`
	Content      string          `json:"content"` // HTML, only with ?content=true
	Departments  []struct {
		Name string `json:"name"`
	} `json:"departments"`
	Offices []struct {
		Name     string `json:"name"`
		Location string `json:"location"`
	} `json:"offices"`
}

type ghMeta struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// ParseGreenhouse parses a Greenhouse API response into normalized jobs.
func ParseGreenhouse(slug string, body []byte, fetchedAt time.Time) ([]model.Job, error) {
	var resp GreenhouseResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("greenhouse parse %s: %w", slug, err)
	}

	jobs := make([]model.Job, 0, len(resp.Jobs))
	for _, j := range resp.Jobs {
		// Extract workplace type from metadata (nullable)
		workplaceType := ""
		if len(j.Metadata) > 0 && string(j.Metadata) != "null" {
			var metas []ghMeta
			if err := json.Unmarshal(j.Metadata, &metas); err == nil {
				for _, m := range metas {
					if strings.Contains(strings.ToLower(m.Name), "location") && m.Value != "" {
						workplaceType = normalize.NormalizeWorkplace(m.Value)
						break
					}
				}
			}
		}

		// Extract department
		dept := ""
		if len(j.Departments) > 0 {
			dept = j.Departments[0].Name
		}

		// Extract description from HTML content
		descPlain := ""
		salaryRaw := ""
		if j.Content != "" {
			// Greenhouse double-encodes HTML entities
			unescaped := strings.NewReplacer(
				"&lt;", "<", "&gt;", ">", "&amp;", "&", "&quot;", `"`, "&#39;", "'",
			).Replace(j.Content)
			descPlain = normalize.StripHTML(unescaped)
			salaryRaw = normalize.ExtractSalary(descPlain)
		}

		companyName := j.CompanyName
		if companyName == "" {
			companyName = slug
		}

		jobs = append(jobs, model.Job{
			ID:               fmt.Sprintf("gh:%s:%d", slug, j.ID),
			Platform:         "greenhouse",
			CompanySlug:      slug,
			CompanyName:      companyName,
			JobID:            fmt.Sprintf("%d", j.ID),
			Title:            strings.TrimSpace(j.Title),
			Location:         j.Location.Name,
			Department:       dept,
			WorkplaceType:    workplaceType,
			JobURL:           j.AbsoluteURL,
			ApplyURL:         j.AbsoluteURL,
			PostedAt:         j.FirstPublished,
			UpdatedAt:        j.UpdatedAt,
			DescriptionPlain: descPlain,
			SalaryRaw:        salaryRaw,
			FetchedAt:        fetchedAt.Format(time.RFC3339),
		})
	}
	return jobs, nil
}
