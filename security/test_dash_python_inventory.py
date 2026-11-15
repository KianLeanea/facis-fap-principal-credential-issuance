# Copyright (c) 2026 LEANEA GmbH and others.
# SPDX-License-Identifier: Apache-2.0
import copy
import hashlib
import tempfile
import unittest
from pathlib import Path

from dash_python_inventory import COMMIT, UPSTREAM, identifiers


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "security/patches").mkdir(parents=True)
        (self.root / "test/bdd").mkdir(parents=True)
        (self.root / "security/patches/bdd-executor-requests.patch").write_text("synthetic fixture\n")
        (self.root / "test/bdd/requirements.txt").write_text(f"git+{UPSTREAM}@{COMMIT}\n")
        self.provenance = {
            "upstream": UPSTREAM, "commit": COMMIT,
            "patch": "security/patches/bdd-executor-requests.patch",
            "patchSha256": hashlib.sha256(b"synthetic fixture\n").hexdigest(),
            "requests": "2.33.0", "changedFiles": ["requirements-dev.txt", "setup.cfg"],
            "preparedSource": str(self.root / "prepared source"),
        }
        self.report = {"install": [
            {"metadata": {"name": "eu_xfsc_bdd", "version": "0.0.7"},
             "download_info": {"url": (self.root / "prepared source").as_uri()}},
            {"metadata": {"name": "requests", "version": "2.33.0"},
             "download_info": {"url": "https://files.pythonhosted.org/synthetic.whl"}},
        ]}

    def test_git_identity_and_actual_requests_version(self):
        result = identifiers(self.report, self.provenance, self.root)
        self.assertIn("git/github/eclipse-xfsc/bdd-executor/" + COMMIT, result)
        self.assertIn("pypi/pypi/-/requests/2.33.0", result)
        self.assertFalse(any("pypi/pypi/-/eu-xfsc-bdd/" in value for value in result))

    def test_different_checkout_is_rejected(self):
        self.report["install"][0]["download_info"]["url"] = (self.root / "other").as_uri()
        with self.assertRaises(ValueError):
            identifiers(self.report, self.provenance, self.root)

    def test_unverified_patch_is_rejected(self):
        self.provenance["patchSha256"] = "0" * 64
        with self.assertRaises(ValueError):
            identifiers(self.report, self.provenance, self.root)

    def test_absent_and_duplicate_bdd_are_rejected(self):
        for values in [self.report["install"][1:], self.report["install"] * 2]:
            with self.assertRaises(ValueError):
                identifiers({"install": values}, self.provenance, self.root)

    def test_unrecognized_local_dependency_is_rejected(self):
        self.report["install"][1]["download_info"]["url"] = (self.root / "unexpected").as_uri()
        with self.assertRaises(ValueError):
            identifiers(self.report, self.provenance, self.root)

    def test_modified_upstream_reference_is_rejected(self):
        changed = copy.deepcopy(self.provenance)
        changed["commit"] = "0" * 40
        with self.assertRaises(ValueError):
            identifiers(self.report, changed, self.root)


if __name__ == "__main__":
    unittest.main()
