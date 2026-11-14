package model

// Job is the normalized representation of a job listing from any platform.
type Job struct {
	ID               string
	Platform         string // "greenhouse" | "lever" | "ashby"
	CompanySlug      string
	CompanyName      string
	JobID            string
	Title            string
	Location         string
	Department       string
	Team             string
	EmploymentType   string // "Full-Time" | "Intern" | "Contract" | "Temporary"
	WorkplaceType    string // "Remote" | "Hybrid" | "On-Site"
	Country          string
	JobURL           string
	ApplyURL         string
	PostedAt         string // ISO 8601 normalized
	UpdatedAt        string
	DescriptionPlain string
	SalaryRaw        string
	FetchedAt        string
}

// CompanyStatus tracks the fetch status of a company's job board.
type CompanyStatus struct {
	Slug         string
	Platform     string
	JobCount     int
	LastFetched  string
	FetchStatus  string // "pending" | "done" | "error" | "empty"
	ErrorMessage string
}

// SearchParams holds all filter/sort options for a search query.
type SearchParams struct {
	Query               string
	SearchDesc          bool
	SearchRaw           bool
	TitleQueryFTS       string
	KeyQueryFTS         string
	ExcludeKeyQueryFTS  string
	ExcludeTitlePhrases []string
	Location            []string
	Markets             []string
	MarketLocation      []string
	MaxPerCompany       int
	Dedupe              bool
	MarketCountry       []string
	WorkplaceType       string // "Remote" | "Hybrid" | "On-Site" | "" (all)
	Since               string // ISO 8601 date string or duration like "7d"
	Before              string
	Platforms           []string
	Companies           []string
	Department          string
	EmploymentType      string
	Country             string
	SortBy              string // "newest" | "oldest" | "company" | "title"
	Limit               int
	Offset              int
	CountOnly           bool
	SkipCount           bool
}

// Stats holds aggregate statistics about the database.
type Stats struct {
	TotalJobs       int
	TotalCompanies  int
	DBSizeBytes     int64
	LastFetch       string
	Platforms       []PlatformStat
	Departments     []NameCount
	WorkplaceTypes  []NameCount
	EmploymentTypes []NameCount
	TopCompanies    []NameCount
}

// PlatformStat holds stats for a single platform.
type PlatformStat struct {
	Platform  string
	Companies int
	Jobs      int
	Empty     int
}

// NameCount is a generic name+count pair for aggregates.
type NameCount struct {
	Name  string
	Count int
}
