package apply

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// testRepoRoot returns the root of the repository by going up 2 levels from
// the internal/apply/ package directory.
func testRepoRoot() string {
	dir, _ := os.Getwd()
	return filepath.Join(dir, "..", "..")
}

// requirePython skips the test if python is not available in PATH.
func requirePython(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("python"); err != nil {
		if _, err2 := exec.LookPath("python3"); err2 != nil {
			t.Skip("python not in PATH")
		}
	}
}

// requirePythonPackage skips if the job_application_automator package is not present.
func requirePythonPackage(t *testing.T) {
	t.Helper()
	root := testRepoRoot()
	pkgDir := filepath.Join(root, "job_application_automator")
	if _, err := os.Stat(pkgDir); err != nil {
		t.Skipf("job_application_automator package not found at %s: %v", pkgDir, err)
	}
}

func TestRuntimeHome_EnvVar(t *testing.T) {
	want := t.TempDir()
	t.Setenv("JOB_AUTOMATOR_HOME", want)

	got := RuntimeHome()

	// The returned path should be an absolute path that matches want.
	wantAbs, _ := filepath.Abs(want)
	gotAbs, _ := filepath.Abs(got)
	if gotAbs != wantAbs {
		t.Errorf("RuntimeHome() = %q, want %q", gotAbs, wantAbs)
	}
}

func TestJobOutputDir(t *testing.T) {
	home := t.TempDir()
	t.Setenv("JOB_AUTOMATOR_HOME", home)

	got := JobOutputDir("ashby", "abc123")

	// The result must contain applications/ashby/abc123.
	wantSuffix := filepath.Join("applications", "ashby", "abc123")
	if !strings.Contains(got, wantSuffix) {
		t.Errorf("JobOutputDir(%q, %q) = %q, want path containing %q", "ashby", "abc123", got, wantSuffix)
	}
}

func TestRunExtractor_Success(t *testing.T) {
	requirePython(t)
	requirePythonPackage(t)

	outputDir := t.TempDir()
	root := testRepoRoot()

	t.Setenv("JOB_AUTOMATOR_MOCK", "1")
	t.Setenv("JOB_AUTOMATOR_PYTHON_DIR", root)

	fieldsPath, err := RunExtractor("ashby", "https://example.com/apply", outputDir, "")
	if err != nil {
		t.Fatalf("RunExtractor() error = %v", err)
	}

	wantPath := filepath.Join(outputDir, "extracted_fields.json")
	if fieldsPath != wantPath {
		t.Errorf("returned path = %q, want %q", fieldsPath, wantPath)
	}

	data, readErr := os.ReadFile(fieldsPath)
	if readErr != nil {
		t.Fatalf("extracted_fields.json not readable: %v", readErr)
	}

	var obj map[string]interface{}
	if err := json.Unmarshal(data, &obj); err != nil {
		t.Fatalf("extracted_fields.json is not valid JSON: %v", err)
	}
}

func TestRunExtractor_Failure(t *testing.T) {
	outputDir := t.TempDir()
	// Point PYTHON at a nonexistent binary — cmd.Start() will fail regardless of sys.path.
	t.Setenv("PYTHON", filepath.Join(t.TempDir(), "nonexistent_python_binary"))
	t.Setenv("JOB_AUTOMATOR_MOCK", "")

	_, err := RunExtractor("ashby", "https://example.com/apply", outputDir, "")
	if err == nil {
		t.Fatal("RunExtractor() expected error with nonexistent python binary, got nil")
	}
}

func TestRunFillerAsync_StartsDontBlock(t *testing.T) {
	requirePython(t)
	requirePythonPackage(t)

	outputDir := t.TempDir()
	root := testRepoRoot()

	t.Setenv("JOB_AUTOMATOR_MOCK", "1")
	t.Setenv("JOB_AUTOMATOR_PYTHON_DIR", root)

	// Write a minimal payload file (mock mode doesn't read it, but the arg is required).
	payloadPath := filepath.Join(outputDir, "fill_payload.json")
	if err := os.WriteFile(payloadPath, []byte(`{}`), 0644); err != nil {
		t.Fatalf("write payload file: %v", err)
	}

	cmd, resultPath, err := RunFillerAsync("ashby", payloadPath, outputDir, "", "")
	if err != nil {
		t.Fatalf("RunFillerAsync() error = %v", err)
	}
	if cmd == nil {
		t.Fatal("RunFillerAsync() returned nil cmd")
	}
	if resultPath == "" {
		t.Fatal("RunFillerAsync() returned empty resultPath")
	}

	wantResultPath := filepath.Join(outputDir, "fill_result.json")
	if resultPath != wantResultPath {
		t.Errorf("resultPath = %q, want %q", resultPath, wantResultPath)
	}

	// Wait for the filler to complete to avoid subprocess leaks.
	result, waitErr := WaitFiller(cmd, resultPath)
	if waitErr != nil {
		t.Fatalf("WaitFiller() error = %v", waitErr)
	}
	if result == "" {
		t.Error("WaitFiller() returned empty result")
	}
}

func TestWaitFiller_ReadsResult(t *testing.T) {
	requirePython(t)
	requirePythonPackage(t)

	outputDir := t.TempDir()
	root := testRepoRoot()

	t.Setenv("JOB_AUTOMATOR_MOCK", "1")
	t.Setenv("JOB_AUTOMATOR_PYTHON_DIR", root)

	payloadPath := filepath.Join(outputDir, "fill_payload.json")
	if err := os.WriteFile(payloadPath, []byte(`{}`), 0644); err != nil {
		t.Fatalf("write payload file: %v", err)
	}

	cmd, resultPath, err := RunFillerAsync("ashby", payloadPath, outputDir, "", "")
	if err != nil {
		t.Fatalf("RunFillerAsync() error = %v", err)
	}

	resultJSON, err := WaitFiller(cmd, resultPath)
	if err != nil {
		t.Fatalf("WaitFiller() error = %v", err)
	}

	// Verify the JSON contains the "submission" key as produced by mock mode.
	var obj map[string]interface{}
	if err := json.Unmarshal([]byte(resultJSON), &obj); err != nil {
		t.Fatalf("fill_result.json is not valid JSON: %v", err)
	}
	if _, ok := obj["submission"]; !ok {
		t.Errorf("fill_result.json missing 'submission' key, got keys: %v", keys(obj))
	}
}

// keys returns the map keys as a slice for diagnostic messages.
func keys(m map[string]interface{}) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	return ks
}
