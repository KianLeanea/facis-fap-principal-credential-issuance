#!/usr/bin/env python3
# Copyright (c) 2026 LEANEA GmbH and others.
# SPDX-License-Identifier: Apache-2.0
"""Build Dash coordinates without relabeling a patched Git source as PyPI."""

import argparse
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import unquote, urlsplit

UPSTREAM = "https://github.com/eclipse-xfsc/bdd-executor"
COMMIT = "478909cdd735bbab8bb63ce955183713d6bb387b"


def identifiers(report, provenance, root):
    root = Path(root)
    patch = root / "security/patches/bdd-executor-requests.patch"
    requirement = f"git+{UPSTREAM}@{COMMIT}"
    if requirement not in (root / "test/bdd/requirements.txt").read_text().splitlines():
        raise ValueError("The official BDD source pin changed.")
    expected = {
        "upstream": UPSTREAM,
        "commit": COMMIT,
        "patch": "security/patches/bdd-executor-requests.patch",
        "patchSha256": hashlib.sha256(patch.read_bytes()).hexdigest(),
        "requests": "2.33.0",
        "changedFiles": ["requirements-dev.txt", "setup.cfg"],
    }
    if any(provenance.get(key) != value for key, value in expected.items()):
        raise ValueError("BDD preparation provenance does not match the tracked source and patch.")
    prepared = Path(provenance["preparedSource"]).resolve()
    result = {"pypi/pypi/-/reportlab/4.4.9"}
    bdd = 0
    for item in report["install"]:
        metadata = item["metadata"]
        name = re.sub(r"[-_.]+", "-", metadata["name"]).lower()
        download = item["download_info"]
        url = urlsplit(download["url"])
        if name == "eu-xfsc-bdd":
            if url.scheme != "file" or url.netloc not in ("", "localhost"):
                raise ValueError("BDD must resolve to the locally prepared official checkout.")
            if Path(unquote(url.path)).resolve() != prepared:
                raise ValueError("BDD package and preparation provenance refer to different paths.")
            bdd += 1
            result.add("git/github/eclipse-xfsc/bdd-executor/" + COMMIT)
            continue
        vcs = download.get("vcs_info")
        if vcs:
            repository = url.path.strip("/").removesuffix(".git")
            if url.hostname != "github.com" or vcs.get("vcs") != "git" or len(repository.split("/")) != 2:
                raise ValueError("Unsupported VCS dependency.")
            if not re.fullmatch(r"[0-9a-f]{40}", vcs.get("commit_id", "")):
                raise ValueError("VCS dependency has no immutable source commit.")
            result.add("git/github/" + repository + "/" + vcs["commit_id"])
        else:
            if url.scheme != "https":
                raise ValueError("Unrecognized local or insecure package origin.")
            result.add("pypi/pypi/-/" + name + "/" + metadata["version"])
    if bdd != 1:
        raise ValueError("Expected exactly one prepared BDD dependency.")
    return sorted(result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--provenance", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    result = identifiers(json.loads(args.report.read_text()), json.loads(args.provenance.read_text()), Path.cwd())
    args.out.write_text("\n".join(result) + "\n")
    print(f"Recorded {len(result)} Dash dependency coordinates; BDD patch provenance retained separately.")


if __name__ == "__main__":
    main()
