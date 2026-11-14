package cmd

import "testing"

func TestValidateFetchOptions(t *testing.T) {
	tests := []struct {
		name    string
		opts    fetchOptions
		wantErr bool
	}{
		{
			name: "valid all platforms",
			opts: fetchOptions{Workers: 80},
		},
		{
			name: "valid selected platforms",
			opts: fetchOptions{Workers: 80, Platforms: []string{"greenhouse", "lever", "ashby"}},
		},
		{
			name: "valid mixed case platform",
			opts: fetchOptions{Workers: 1, Platforms: []string{" GreenHouse "}},
		},
		{
			name:    "invalid platform",
			opts:    fetchOptions{Workers: 80, Platforms: []string{"greenhouse", "workday"}},
			wantErr: true,
		},
		{
			name:    "zero workers",
			opts:    fetchOptions{Workers: 0},
			wantErr: true,
		},
		{
			name:    "negative workers",
			opts:    fetchOptions{Workers: -5},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateFetchOptions(tt.opts)
			if (err != nil) != tt.wantErr {
				t.Fatalf("validateFetchOptions() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}
