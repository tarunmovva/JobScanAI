package parser

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"jobscan/internal/model"
	"jobscan/internal/normalize"
)

// AshbyResponse is the top-level API response.
type AshbyResponse struct {
	Jobs []AshbyJob `json:"jobs"`
}

// AshbyJob is a single job from the Ashby API.
type AshbyJob struct {
	ID                 string `json:"id"`
	Title              string `json:"title"`
	Department         string `json:"department"`
	Team               string `json:"team"`
	EmploymentType     string `json:"employmentType"`
	Location           string `json:"location"`
	IsRemote           bool   `json:"isRemote"`
	WorkplaceType      string `json:"workplaceType"` // "OnSite" | "Hybrid" | "Remote" | null
	IsListed           bool   `json:"isListed"`
	PublishedAt        string `json:"publishedAt"`
	JobURL             string `json:"jobUrl"`
	ApplyURL           string `json:"applyUrl"`
	DescriptionPlain   string `json:"descriptionPlain"`
	SecondaryLocations []struct {
		Location string `json:"location"`
	} `json:"secondaryLocations"`
	Address struct {
		PostalAddress struct {
			AddressLocality string `json:"addressLocality"`
			AddressRegion   string `json:"addressRegion"`
			AddressCountry  string `json:"addressCountry"`
		} `json:"postalAddress"`
	} `json:"address"`
}

// ParseAshby parses an Ashby API response into normalized jobs.
func ParseAshby(slug string, body []byte, fetchedAt time.Time) ([]model.Job, error) {
	var resp AshbyResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("ashby parse %s: %w", slug, err)
	}

	result := make([]model.Job, 0, len(resp.Jobs))
	for _, j := range resp.Jobs {
		// Skip unlisted jobs
		if !j.IsListed {
			continue
		}

		// Build location string: primary + secondary
		locations := []string{}
		if j.Location != "" {
			locations = append(locations, j.Location)
		}
		for _, sl := range j.SecondaryLocations {
			if sl.Location != "" && sl.Location != j.Location {
				locations = append(locations, sl.Location)
			}
		}
		location := strings.Join(locations, " / ")

		// Extract country from structured address
		country := j.Address.PostalAddress.AddressCountry

		// Normalize workplace: prefer workplaceType, fall back to isRemote
		workplaceRaw := j.WorkplaceType
		if workplaceRaw == "" && j.IsRemote {
			workplaceRaw = "Remote"
		}

		salaryRaw := normalize.ExtractSalary(j.DescriptionPlain)

		result = append(result, model.Job{
			ID:               fmt.Sprintf("ab:%s:%s", slug, j.ID),
			Platform:         "ashby",
			CompanySlug:      slug,
			CompanyName:      slug,
			JobID:            j.ID,
			Title:            strings.TrimSpace(j.Title),
			Location:         location,
			Department:       j.Department,
			Team:             j.Team,
			EmploymentType:   normalize.NormalizeEmployment(j.EmploymentType),
			WorkplaceType:    normalize.NormalizeWorkplace(workplaceRaw),
			Country:          country,
			JobURL:           j.JobURL,
			ApplyURL:         j.ApplyURL,
			PostedAt:         j.PublishedAt,
			DescriptionPlain: j.DescriptionPlain,
			SalaryRaw:        salaryRaw,
			FetchedAt:        fetchedAt.Format(time.RFC3339),
		})
	}
	return result, nil
}
