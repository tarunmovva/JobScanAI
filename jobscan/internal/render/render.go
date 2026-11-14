package render

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"jobscan/internal/model"

	"github.com/olekukonko/tablewriter"
)

// platformShort returns a short 2-letter platform code.
func platformShort(p string) string {
	switch p {
	case "greenhouse":
		return "GH"
	case "lever":
		return "LV"
	case "ashby":
		return "AB"
	}
	return strings.ToUpper(p[:2])
}

// formatDate trims a date string to YYYY-MM-DD for display.
func formatDate(s string) string {
	if len(s) >= 10 {
		return s[:10]
	}
	return s
}

// truncate clips a string to maxLen with ellipsis.
func truncate(s string, maxLen int) string {
	s = strings.TrimSpace(s)
	if len([]rune(s)) <= maxLen {
		return s
	}
	runes := []rune(s)
	return string(runes[:maxLen-1]) + "…"
}

// Table renders jobs as a terminal table.
func Table(w io.Writer, jobs []model.Job, total int, elapsed time.Duration) {
	if len(jobs) == 0 {
		fmt.Fprintln(w, "  No results found.")
		return
	}

	table := tablewriter.NewWriter(w)
	table.SetHeader([]string{"Company", "Title", "Location", "Type", "Posted", "Src", "Link"})
	table.SetBorder(true)
	table.SetRowLine(false)
	table.SetAutoWrapText(false)
	table.SetHeaderColor(
		tablewriter.Colors{tablewriter.Bold},
		tablewriter.Colors{tablewriter.Bold},
		tablewriter.Colors{tablewriter.Bold},
		tablewriter.Colors{tablewriter.Bold},
		tablewriter.Colors{tablewriter.Bold},
		tablewriter.Colors{tablewriter.Bold},
		tablewriter.Colors{tablewriter.Bold},
	)
	table.SetColumnColor(
		tablewriter.Colors{tablewriter.FgCyanColor},
		tablewriter.Colors{},
		tablewriter.Colors{tablewriter.FgYellowColor},
		tablewriter.Colors{tablewriter.FgGreenColor},
		tablewriter.Colors{tablewriter.FgWhiteColor},
		tablewriter.Colors{tablewriter.FgMagentaColor},
		tablewriter.Colors{tablewriter.FgBlueColor},
	)

	for i, j := range jobs {
		wt := j.WorkplaceType
		if wt == "" {
			wt = "-"
		}
		companyName := j.CompanyName
		if companyName == "" {
			companyName = j.CompanySlug
		}
		table.Append([]string{
			fmt.Sprintf("%2d. %s", i+1, truncate(companyName, 20)),
			truncate(j.Title, 42),
			truncate(j.Location, 22),
			wt,
			formatDate(j.PostedAt),
			platformShort(j.Platform),
			j.JobURL,
		})
	}
	table.Render()

	showing := len(jobs)
	if total < 0 {
		fmt.Fprintf(w, "  Showing %d results (%s)\n", showing, elapsed.Round(time.Millisecond))
		return
	}
	fmt.Fprintf(w, "  Showing %d of %d results (%s)\n", showing, total, elapsed.Round(time.Millisecond))
	if total > showing {
		fmt.Fprintf(w, "  Use --limit and --offset to paginate, or --limit 0 for all results.\n")
	}
}

// JSON renders jobs as a JSON array.
func JSON(w io.Writer, jobs []model.Job) error {
	type jsonJob struct {
		ID             string `json:"id"`
		JobID          string `json:"job_id"`
		Company        string `json:"company"`
		// CompanySlug is what --company matches on, so without it in the output
		// nothing downstream can ever learn a real slug to feed back in.
		CompanySlug    string `json:"company_slug,omitempty"`
		Title          string `json:"title"`
		Location       string `json:"location"`
		WorkplaceType  string `json:"workplace_type,omitempty"`
		EmploymentType string `json:"employment_type,omitempty"`
		Department     string `json:"department,omitempty"`
		Team           string `json:"team,omitempty"`
		Country        string `json:"country,omitempty"`
		PostedAt       string `json:"posted_at,omitempty"`
		Platform       string `json:"platform"`
		JobURL         string `json:"job_url,omitempty"`
		ApplyURL       string `json:"apply_url,omitempty"`
		// Populated on 159,550 of 271,700 jobs and selected by the query, but
		// dropped here — so the AI rater scored every job with no compensation
		// signal at all. CSV already carried it; JSON did not.
		Salary         string `json:"salary,omitempty"`
		Description    string `json:"description,omitempty"`
	}

	out := make([]jsonJob, len(jobs))
	for i, j := range jobs {
		name := j.CompanyName
		if name == "" {
			name = j.CompanySlug
		}
		out[i] = jsonJob{
			ID:             j.ID,
			JobID:          j.JobID,
			Company:        name,
			CompanySlug:    j.CompanySlug,
			Title:          j.Title,
			Location:       j.Location,
			WorkplaceType:  j.WorkplaceType,
			EmploymentType: j.EmploymentType,
			Department:     j.Department,
			Team:           j.Team,
			Country:        j.Country,
			PostedAt:       formatDate(j.PostedAt),
			Platform:       j.Platform,
			JobURL:         j.JobURL,
			ApplyURL:       j.ApplyURL,
			Salary:         j.SalaryRaw,
			Description:    j.DescriptionPlain,
		}
	}

	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(out)
}

// CSV renders jobs as CSV.
func CSV(w io.Writer, jobs []model.Job) error {
	cw := csv.NewWriter(w)
	defer cw.Flush()

	// Header
	if err := cw.Write([]string{
		"Company", "Title", "Location", "WorkplaceType", "EmploymentType",
		"Department", "Team", "Country", "PostedAt", "Platform", "JobURL", "ApplyURL", "Salary",
	}); err != nil {
		return err
	}

	for _, j := range jobs {
		name := j.CompanyName
		if name == "" {
			name = j.CompanySlug
		}
		if err := cw.Write([]string{
			name, j.Title, j.Location, j.WorkplaceType, j.EmploymentType,
			j.Department, j.Team, j.Country, formatDate(j.PostedAt),
			j.Platform, j.JobURL, j.ApplyURL, j.SalaryRaw,
		}); err != nil {
			return err
		}
	}
	return cw.Error()
}

// Stats renders the stats output.
func Stats(w io.Writer, stats *model.Stats, dbPath string) {
	sizeMB := float64(stats.DBSizeBytes) / 1024 / 1024

	fmt.Fprintf(w, "\n  Database: %s (%.1f MB)\n", dbPath, sizeMB)
	if stats.LastFetch != "" {
		fmt.Fprintf(w, "  Last fetch: %s\n\n", formatDate(stats.LastFetch))
	} else {
		fmt.Fprintf(w, "  Last fetch: never\n\n")
	}

	// Platform table
	platTable := tablewriter.NewWriter(w)
	platTable.SetHeader([]string{"Platform", "Companies", "Jobs", "Empty/Error"})
	platTable.SetBorder(true)
	platTable.SetColumnAlignment([]int{
		tablewriter.ALIGN_LEFT,
		tablewriter.ALIGN_RIGHT,
		tablewriter.ALIGN_RIGHT,
		tablewriter.ALIGN_RIGHT,
	})
	for _, ps := range stats.Platforms {
		platTable.Append([]string{
			strings.Title(ps.Platform),
			fmt.Sprintf("%d", ps.Companies),
			fmt.Sprintf("%d", ps.Jobs),
			fmt.Sprintf("%d", ps.Empty),
		})
	}
	platTable.SetFooter([]string{
		"Total",
		fmt.Sprintf("%d", stats.TotalCompanies),
		fmt.Sprintf("%d", stats.TotalJobs),
		"",
	})
	platTable.Render()

	// Top departments
	if len(stats.Departments) > 0 {
		fmt.Fprintln(w, "\n  Top Departments:")
		for _, d := range stats.Departments {
			fmt.Fprintf(w, "    %-28s %d\n", d.Name, d.Count)
		}
	}

	// Workplace types
	if len(stats.WorkplaceTypes) > 0 {
		fmt.Fprintln(w, "\n  Workplace Types:")
		for _, wt := range stats.WorkplaceTypes {
			pct := 0.0
			if stats.TotalJobs > 0 {
				pct = float64(wt.Count) / float64(stats.TotalJobs) * 100
			}
			name := wt.Name
			if name == "" {
				name = "Unknown"
			}
			fmt.Fprintf(w, "    %-12s %d (%.1f%%)\n", name, wt.Count, pct)
		}
	}

	// Employment types
	if len(stats.EmploymentTypes) > 0 {
		fmt.Fprintln(w, "\n  Employment Types:")
		for _, et := range stats.EmploymentTypes {
			name := et.Name
			if name == "" {
				name = "Unknown"
			}
			pct := 0.0
			if stats.TotalJobs > 0 {
				pct = float64(et.Count) / float64(stats.TotalJobs) * 100
			}
			fmt.Fprintf(w, "    %-12s %d (%.1f%%)\n", name, et.Count, pct)
		}
	}

	// Top companies
	if len(stats.TopCompanies) > 0 {
		fmt.Fprintln(w, "\n  Top Hiring Companies:")
		for _, c := range stats.TopCompanies {
			fmt.Fprintf(w, "    %-30s %d\n", c.Name, c.Count)
		}
	}
	fmt.Fprintln(w)

	// Suppress unused import warning
	_ = os.Stderr
}
