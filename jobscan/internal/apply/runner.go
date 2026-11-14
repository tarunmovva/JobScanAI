package apply

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// RuntimeHome returns the root directory for application run artifacts.
// Priority order: $JOB_AUTOMATOR_HOME → ./.job-automator (if exists) → ~/.job-automator
// The returned path is always absolute.
func RuntimeHome() string {
	if h := os.Getenv("JOB_AUTOMATOR_HOME"); h != "" {
		abs, err := filepath.Abs(h)
		if err == nil {
			return abs
		}
		return h
	}

	// Use ./.job-automator if it already exists (dev / project-local usage).
	local := ".job-automator"
	if _, err := os.Stat(local); err == nil {
		abs, err := filepath.Abs(local)
		if err == nil {
			return abs
		}
	}

	// Fall back to ~/.job-automator
	home, err := os.UserHomeDir()
	if err == nil {
		return filepath.Join(home, ".job-automator")
	}

	// Last resort: absolute path of local dir even if it doesn't exist yet.
	abs, err := filepath.Abs(local)
	if err == nil {
		return abs
	}
	return local
}

// JobOutputDir returns the per-job output directory path.
// Pattern: {RuntimeHome}/applications/{platform}/{jobID}/
func JobOutputDir(platform, jobID string) string {
	return filepath.Join(RuntimeHome(), "applications", platform, jobID)
}

// pythonBinary returns the Python executable to use.
// Uses the $PYTHON env var if set, otherwise falls back to "python".
func pythonBinary() string {
	if py := os.Getenv("PYTHON"); py != "" {
		return py
	}
	return "python"
}

// pythonPackageRoot returns the working directory from which Python scripts
// should be launched (the directory that contains job_application_automator/).
// Priority order:
//  1. $JOB_AUTOMATOR_PYTHON_DIR
//  2. Directory of the running executable
//  3. Current working directory
func pythonPackageRoot() string {
	if d := os.Getenv("JOB_AUTOMATOR_PYTHON_DIR"); d != "" {
		return d
	}

	if exe, err := os.Executable(); err == nil {
		return filepath.Dir(exe)
	}

	if cwd, err := os.Getwd(); err == nil {
		return cwd
	}

	return "."
}

// RunExtractor runs the platform-specific extractor for a job application form.
// It invokes:
//
//	python -m job_application_automator.extractor_cli
//	    --platform PLATFORM --apply-url URL --output-dir DIR [--board BOARD]
//
// board is the Greenhouse board token (the job's company slug). A posting on a
// company's own careers domain does not carry it in the URL, and without it
// the extractor can reach neither the questions API nor the board's own
// application form -- it is left to whatever forms the careers site draws.
//
// Blocks until completion. Returns the path to extracted_fields.json on success.
// If JOB_AUTOMATOR_MOCK env var is "1", passes it through to the subprocess.
func RunExtractor(platform, applyURL, outputDir, board string) (fieldsPath string, err error) {
	if err := os.MkdirAll(outputDir, 0755); err != nil {
		return "", fmt.Errorf("create output dir %q: %w", outputDir, err)
	}

	args := []string{
		"-m", "job_application_automator.extractor_cli",
		"--platform", platform,
		"--apply-url", applyURL,
		"--output-dir", outputDir,
	}
	if platform == "greenhouse" && board != "" {
		args = append(args, "--board", board)
	}

	cmd := exec.Command(pythonBinary(), args...)
	cmd.Dir = pythonPackageRoot()
	cmd.Env = os.Environ()

	out, runErr := cmd.CombinedOutput()
	if runErr != nil {
		return "", fmt.Errorf("extractor failed: %w\n%s", runErr, out)
	}

	fieldsPath = filepath.Join(outputDir, "extracted_fields.json")
	return fieldsPath, nil
}

// RunFillerAsync launches the platform-specific filler as a background subprocess.
//
// Greenhouse: calls greenhouse_fast_form_filler with --imap-config pointing to
// {RuntimeHome}/secrets/imap_config.json for OTP email reading.
//
// Ashby/Lever: calls filler_cli dispatcher; otpMailbox (format: "provider:account")
// is passed as --otp-mailbox when non-empty.
//
// Returns immediately; caller must call WaitFiller to collect results.
//
// board is passed to the greenhouse filler for the same reason as to the
// extractor: both stages must choose the same form, or no answer key matches.
func RunFillerAsync(platform, payloadPath, outputDir, otpMailbox, board string) (*exec.Cmd, string, error) {
	if err := os.MkdirAll(outputDir, 0755); err != nil {
		return nil, "", fmt.Errorf("create output dir %q: %w", outputDir, err)
	}

	var args []string

	if platform == "greenhouse" {
		imapConfigPath := filepath.Join(RuntimeHome(), "secrets", "imap_config.json")
		args = []string{
			"-m", "job_application_automator.greenhouse_fast_form_filler",
			payloadPath, outputDir,
			"--submit",
			"--otp", "auto",
			"--imap-config", imapConfigPath,
		}
		if board != "" {
			args = append(args, "--board", board)
		}
	} else {
		args = []string{
			"-m", "job_application_automator.filler_cli",
			"--platform", platform,
			"--payload-file", payloadPath,
			"--output-dir", outputDir,
		}
		if otpMailbox != "" {
			args = append(args, "--otp-mailbox", otpMailbox)
		}
	}

	cmd := exec.Command(pythonBinary(), args...)
	cmd.Dir = pythonPackageRoot()
	cmd.Env = os.Environ()

	// Forward subprocess I/O: allow human to type CAPTCHA solutions via stdin,
	// and surface filler output on stderr so stdout stays clean for parsing.
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		return nil, "", fmt.Errorf("start filler: %w", err)
	}

	resultPath := filepath.Join(outputDir, "fill_result.json")
	return cmd, resultPath, nil
}

// WaitFiller waits for a filler subprocess to complete and reads its fill_result.json.
// resultPath is the expected path of fill_result.json in the output dir.
// Returns the raw JSON string on success (and also on failure if partial results exist).
func WaitFiller(cmd *exec.Cmd, resultPath string) (string, error) {
	waitErr := cmd.Wait()

	content, readErr := os.ReadFile(resultPath)
	if waitErr != nil {
		if readErr == nil {
			return string(content), fmt.Errorf("filler failed: %w", waitErr)
		}
		return "", fmt.Errorf("filler failed: %w", waitErr)
	}

	if readErr != nil {
		return "", fmt.Errorf("read fill_result.json: %w", readErr)
	}

	return string(content), nil
}
