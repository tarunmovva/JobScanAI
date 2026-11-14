"""Which model the recovery agent runs on.

It used to be whatever codex's config.toml pinned, because _build_codex_argv
passed -m only when an env override was set. That default can be the most
expensive model available, while the app was deliberately
configured to the cheapest. At a mean 286k input tokens per recovery run that
was the largest single cost in the path, and nothing surfaced it: the model
never appeared in a log line or a result field.
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from job_application_automator import agent_recovery as ar  # noqa: E402


class RecoveryModelTests(unittest.TestCase):
    def setUp(self):
        self._env = os.environ.get("JOB_AUTOMATOR_RECOVERY_MODEL")

    def tearDown(self):
        if self._env is None:
            os.environ.pop("JOB_AUTOMATOR_RECOVERY_MODEL", None)
        else:
            os.environ["JOB_AUTOMATOR_RECOVERY_MODEL"] = self._env

    def test_the_model_is_always_passed_explicitly(self):
        # The bug was an absent -m, which silently inherits config.toml.
        # Pretend Codex is installed: without it the builder returns None,
        # and a CI runner has no Codex.
        with mock.patch.object(ar, "_resolve_codex", return_value=["codex"]):
            argv = ar._build_codex_argv(Path("."))
        self.assertIsNotNone(argv)
        self.assertIn("-m", argv, "no -m means config.toml decides, not us")
        self.assertTrue(argv[argv.index("-m") + 1].strip())

    def test_an_explicit_override_wins(self):
        os.environ["JOB_AUTOMATOR_RECOVERY_MODEL"] = "some-other-model"
        self.assertEqual(ar._recovery_model(), "some-other-model")

    def test_it_never_falls_back_to_an_empty_model(self):
        os.environ.pop("JOB_AUTOMATOR_RECOVERY_MODEL", None)
        self.assertTrue(ar._recovery_model().strip())

    def test_the_hardcoded_fallback_is_the_cheap_one(self):
        # If the app config is ever unreadable, the floor must not be an
        # expensive model. The user's standing instruction is the cheapest.
        self.assertEqual(ar.DEFAULT_RECOVERY_MODEL, "gpt-5.6-luna")


if __name__ == "__main__":
    unittest.main(verbosity=2)
