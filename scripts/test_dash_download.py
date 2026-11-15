#!/usr/bin/env python3
# Copyright (c) 2026 LEANEA GmbH and others.
#
# This program and the accompanying materials are made available under the
# terms of the Apache License, Version 2.0 which is available at
# https://www.apache.org/licenses/LICENSE-2.0.
#
# SPDX-License-Identifier: Apache-2.0

"""Offline regressions for fail-closed Dash retrieval; no services are used."""

import hashlib
import importlib.util
import io
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("pci_dash_download", Path(__file__).with_name("download-dash.py"))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.output = Path(self.folder.name) / "dash.jar"
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as archive:
            archive.writestr("META-INF/MANIFEST.MF", "Main-Class: example.Fixture\n")
        self.raw = stream.getvalue()
        self.digest = hashlib.sha256(self.raw).hexdigest()

    def checker(self, path):
        return MODULE.verify(path, expected=self.digest)

    def good(self, kind, url, target):
        Path(target).write_bytes(self.raw)

    def test_fixed_production_pin(self):
        self.assertEqual(MODULE.VERSION, "1.1.0")
        self.assertEqual(MODULE.SHA256, "ba4e84e1981f0e51f92a42ec8fc8b9668dabb08d1279afde46b8414e11752b06")
        self.assertIn("?ref=" + MODULE.SCORE_COMMIT, MODULE.API_PATH)

    def test_verified_download_is_promoted(self):
        result = MODULE.obtain(self.output, self.good, self.checker)
        self.assertEqual(self.output.read_bytes(), self.raw)
        self.assertEqual(result["source"], MODULE.API_URL)

    def test_network_failure_uses_next_source(self):
        calls = []
        def fetch(kind, url, target):
            calls.append(url)
            if len(calls) == 1:
                raise OSError("synthetic network outage")
            self.good(kind, url, target)
        MODULE.obtain(self.output, fetch, self.checker)
        self.assertEqual(len(calls), 2)

    def test_hash_mismatch_is_not_a_network_fallback(self):
        calls = []
        def fetch(kind, url, target):
            calls.append(url)
            Path(target).write_bytes(b"wrong bytes")
        with self.assertRaises(MODULE.IntegrityError):
            MODULE.obtain(self.output, fetch, self.checker)
        self.assertEqual(len(calls), 1)
        self.assertFalse(self.output.exists())
        self.assertEqual(list(self.output.parent.glob(".dash-part-*")), [])

    def test_all_network_failures_leave_no_output(self):
        def fail(*args):
            raise OSError("synthetic service failure")
        with self.assertRaises(OSError):
            MODULE.obtain(self.output, fail, self.checker)
        self.assertFalse(self.output.exists())
        self.assertEqual(list(self.output.parent.glob(".dash-part-*")), [])

    def test_valid_cache_is_checked_without_network(self):
        self.output.write_bytes(self.raw)
        def fail(*args):
            self.fail("The verified cache must not need the network.")
        result = MODULE.obtain(self.output, fail, self.checker)
        self.assertEqual(result["source"], "verified-existing-file")

    def test_invalid_cache_is_preserved_and_rejected(self):
        self.output.write_bytes(b"untrusted cache")
        with self.assertRaises(MODULE.IntegrityError):
            MODULE.obtain(self.output, self.good, self.checker)
        self.assertEqual(self.output.read_bytes(), b"untrusted cache")

    def test_archive_without_manifest_is_rejected(self):
        with zipfile.ZipFile(self.output, "w") as archive:
            archive.writestr("not-a-manifest", "fixture")
        digest = hashlib.sha256(self.output.read_bytes()).hexdigest()
        with self.assertRaises(MODULE.IntegrityError):
            MODULE.verify(self.output, expected=digest)

    def test_non_zip_bytes_are_rejected_after_matching_hash(self):
        self.output.write_bytes(b"not a ZIP")
        digest = hashlib.sha256(self.output.read_bytes()).hexdigest()
        with self.assertRaises(MODULE.IntegrityError):
            MODULE.verify(self.output, expected=digest)

    def test_symlink_output_is_rejected(self):
        target = self.output.with_name("target.jar")
        target.write_bytes(self.raw)
        self.output.symlink_to(target)
        with self.assertRaises(MODULE.IntegrityError):
            MODULE.obtain(self.output, self.good, self.checker)

    def test_github_auth_is_scoped_to_fixed_host(self):
        with patch.object(MODULE.shutil, "which", return_value="/usr/bin/gh"), \
                patch.object(MODULE.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b"", b"")) as run:
            MODULE.transfer("github-api", MODULE.API_URL, self.output)
        command = run.call_args.args[0]
        self.assertEqual(command[:4], ["gh", "api", "--hostname", "github.com"])
        self.assertEqual(command[-1], MODULE.API_PATH)
        self.assertNotIn("--token", command)


if __name__ == "__main__":
    unittest.main()
