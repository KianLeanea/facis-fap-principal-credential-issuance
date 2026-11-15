#!/usr/bin/env python3
# Copyright (c) 2026 LEANEA GmbH and others.
#
# This program and the accompanying materials are made available under the
# terms of the Apache License, Version 2.0 which is available at
# https://www.apache.org/licenses/LICENSE-2.0.
#
# SPDX-License-Identifier: Apache-2.0

"""Retrieve the original Dash 1.1.0 bytes and verify the fixed SHA-256."""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

VERSION = "1.1.0"
SHA256 = "ba4e84e1981f0e51f92a42ec8fc8b9668dabb08d1279afde46b8414e11752b06"
SCORE_COMMIT = "932c3c021f7fe46c5ddf0996e1b347f552ed7c29"
SCORE_PATH = "dash/org.eclipse.dash.licenses-1.1.0.jar"
API_PATH = "repos/eclipse-score/tooling/contents/" + SCORE_PATH + "?ref=" + SCORE_COMMIT
API_URL = "https://api.github.com/" + API_PATH
SOURCES = [
    ("github-api", API_URL),
    ("https", "https://raw.githubusercontent.com/eclipse-score/tooling/" + SCORE_COMMIT + "/" + SCORE_PATH),
    ("https", "https://repo.eclipse.org/repository/dash-maven2-releases/org/eclipse/dash/"
     "org.eclipse.dash.licenses/1.1.0/org.eclipse.dash.licenses-1.1.0.jar"),
    ("https", "https://repo.eclipse.org/content/repositories/dash-licenses-releases/org/eclipse/dash/"
     "org.eclipse.dash.licenses/1.1.0/org.eclipse.dash.licenses-1.1.0.jar"),
]
MAX_BYTES = 32 * 1024 * 1024


class IntegrityError(ValueError):
    """An available file does not match the immutable trusted artifact."""


def verify(path, expected=SHA256):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= MAX_BYTES:
        raise IntegrityError("Invalid Dash archive file or size.")
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise IntegrityError("Dash SHA-256 mismatch; the file was not accepted.")
    try:
        with zipfile.ZipFile(path) as archive:
            if "META-INF/MANIFEST.MF" not in archive.namelist() or archive.testzip() is not None:
                raise IntegrityError("The verified bytes are not a valid executable JAR.")
    except zipfile.BadZipFile as error:
        raise IntegrityError("The verified bytes are not a ZIP/JAR.") from error


def transfer(kind, url, target):
    if kind == "github-api" and shutil.which("gh"):
        # gh supplies authentication only to api.github.com; no token is logged.
        with Path(target).open("wb") as stream:
            result = subprocess.run(
                ["gh", "api", "--hostname", "github.com", "-H",
                 "Accept: application/vnd.github.raw+json", API_PATH],
                stdout=stream, stderr=subprocess.PIPE, timeout=180, check=False,
            )
        if result.returncode:
            raise OSError("The pinned GitHub API download is unavailable.")
        return
    headers = {"User-Agent": "eclipse-xfsc-pci-dash-download"}
    if kind == "github-api":
        headers["Accept"] = "application/vnd.github.raw+json"
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=40) as response, Path(target).open("wb") as stream:
        total = 0
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_BYTES:
                raise IntegrityError("The download exceeded the permitted JAR size.")
            stream.write(chunk)


def obtain(output, fetch=transfer, checker=verify, sources=None):
    output = Path(output)
    if output.exists() or output.is_symlink():
        checker(output)
        return {"version": VERSION, "sha256": SHA256, "source": "verified-existing-file"}
    output.parent.mkdir(parents=True, exist_ok=True)
    errors = []
    for kind, url in SOURCES if sources is None else sources:
        descriptor, name = tempfile.mkstemp(prefix=".dash-part-", dir=output.parent)
        os.close(descriptor)
        temporary = Path(name)
        try:
            fetch(kind, url, temporary)
            checker(temporary)
            temporary.replace(output)
            return {"version": VERSION, "sha256": SHA256, "source": url,
                    "vendoredCopyCommit": SCORE_COMMIT if "eclipse-score" in url else None}
        except IntegrityError:
            raise
        except (OSError, urllib.error.URLError, subprocess.TimeoutExpired):
            errors.append(url)
            print("Download unavailable; trying the next pinned source.", flush=True)
        finally:
            temporary.unlink(missing_ok=True)
    raise OSError("No verified Dash JAR could be obtained from " + str(len(errors)) + " pinned sources.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--provenance", type=Path)
    args = parser.parse_args()
    result = obtain(args.output)
    if args.provenance:
        args.provenance.parent.mkdir(parents=True, exist_ok=True)
        args.provenance.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"suite": "dash-tool-integrity", "status": "PASS", **result}))


if __name__ == "__main__":
    main()
