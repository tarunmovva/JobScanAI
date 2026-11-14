package parser

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"jobscan/internal/model"
	"jobscan/internal/normalize"
)

// LeverJob is a single posting from the Lever API (array response).
type LeverJob struct {
	ID             string `json:"id"`
	Text           string `json:"text"` // job title
	HostedURL      string `json:"hostedUrl"`
	ApplyURL       string `json:"applyUrl"`
	CreatedAt      int64  `json:"createdAt"` // Unix milliseconds
	WorkplaceType  string `json:"workplaceType"`
	Country        string `json:"country"`
	Categories     struct {
		Commitment  string   `json:"commitment"`
		Department  string   `json:"department"`
		Team        string   `json:"team"`
		Location    string   `json:"location"`
		AllLocations []string `json:"allLocations"`
	} `json:"categories"`
	DescriptionPlain    string `json:"descriptionPlain"`
	AdditionalPlain     string `json:"additionalPlain"`
	Lists               []struct {
		Text    string `json:"text"`
		Content string `json:"content"` // HTML list items
	} `json:"lists"`
}

// ParseLever parses a Lever API response (JSON array) into normalized jobs.
func ParseLever(slug string, body []byte, fetchedAt time.Time) ([]model.Job, error) {
	var jobs []LeverJob
	if err := json.Unmarshal(body, &jobs); err != nil {
		return nil, fmt.Errorf("lever parse %s: %w", slug, err)
	}

	result := make([]model.Job, 0, len(jobs))
	for _, j := range jobs {
		// Build full searchable description from all text fields
		var descParts []string
		if j.DescriptionPlain != "" {
			descParts = append(descParts, j.DescriptionPlain)
		}
		// Strip HTML from lists
		for _, l := range j.Lists {
			text := normalize.StripHTML(l.Content)
			if text != "" {
				if l.Text != "" {
					descParts = append(descParts, l.Text+": "+text)
				} else {
					descParts = append(descParts, text)
				}
			}
		}
		if j.AdditionalPlain != "" {
			descParts = append(descParts, j.AdditionalPlain)
		}
		descPlain := strings.Join(descParts, "\n\n")

		// Salary is most commonly in additionalPlain
		salaryRaw := normalize.ExtractSalary(j.AdditionalPlain)
		if salaryRaw == "" {
			salaryRaw = normalize.ExtractSalary(descPlain)
		}

		// Best location: use allLocations joined if multiple
		location := j.Categories.Location
		if len(j.Categories.AllLocations) > 1 {
			location = strings.Join(j.Categories.AllLocations, ", ")
		}

		result = append(result, model.Job{
			ID:               fmt.Sprintf("lv:%s:%s", slug, j.ID),
			Platform:         "lever",
			CompanySlug:      slug,
			CompanyName:      slug,
			JobID:            j.ID,
			Title:            strings.TrimSpace(j.Text),
			Location:         location,
			Department:       j.Categories.Department,
			Team:             j.Categories.Team,
			EmploymentType:   normalize.NormalizeEmployment(j.Categories.Commitment),
			WorkplaceType:    normalize.NormalizeWorkplace(j.WorkplaceType),
			Country:          strings.ToUpper(j.Country),
			JobURL:           j.HostedURL,
			ApplyURL:         j.ApplyURL,
			PostedAt:         normalize.NormalizeLeverDate(j.CreatedAt),
			DescriptionPlain: descPlain,
			SalaryRaw:        salaryRaw,
			FetchedAt:        fetchedAt.Format(time.RFC3339),
		})
	}
	return result, nil
}
