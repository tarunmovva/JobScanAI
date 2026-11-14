package model

import "time"

type ApplicationStatus string

const (
	StatusQueued     ApplicationStatus = "queued"
	StatusExtracting ApplicationStatus = "extracting"
	StatusExtracted  ApplicationStatus = "extracted"
	StatusClaimed    ApplicationStatus = "claimed"
	StatusFilling    ApplicationStatus = "filling"
	StatusSubmitted  ApplicationStatus = "submitted"
	StatusFailed     ApplicationStatus = "failed"
)

type Application struct {
	ID                  int64
	JobID               string
	Platform            string
	CompanySlug         string
	CompanyName         string
	JobTitle            string
	ApplyURL            string
	Status              ApplicationStatus
	ExtractedFieldsPath string
	FillPayloadPath     string
	FillResult          string // JSON blob
	ClaimToken          string
	ClaimedAt           *time.Time
	Error               string
	CreatedAt           time.Time
	UpdatedAt           time.Time
}
