import hashlib
import io
import json
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from urllib.error import HTTPError
from zipfile import ZipFile, ZipInfo

from artifact import ARTIFACT_API, InvalidArtifact, download_image, unpack_image


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def zip_bytes(members):
    data = io.BytesIO()
    with ZipFile(data, "w") as archive:
        for member, content in members:
            archive.writestr(member, content)
    return data.getvalue()


class GitHubArtifact:
    def __init__(self, env, image, **metadata):
        self.zip = zip_bytes([("image.tar", image)])
        self.location = "https://example.blob.core.windows.net/signed"
        self.base = f"{ARTIFACT_API}/{env['ARTIFACT_ID']}"
        self.downloaded = False
        env["ARTIFACT_DIGEST"] = sha256(self.zip)
        self.metadata = {
            "id": int(env["ARTIFACT_ID"]),
            "name": f"workspace-backend-pr-{env['PR_NUMBER']}-{env['GIT_SHA']}-{env['GITHUB_RUN_ATTEMPT']}",
            "expired": False,
            "size_in_bytes": len(self.zip),
            "digest": f"sha256:{sha256(self.zip)}",
            "workflow_run": {
                "id": int(env["GITHUB_RUN_ID"]),
                "repository_id": 1015951989,
                "head_repository_id": 1015951989,
                "head_branch": "main",
                "head_sha": env["GITHUB_WORKFLOW_SHA"],
            },
            **metadata,
        }

    def open(self, request, timeout):
        if request.full_url == self.location:
            assert request.get_header("Authorization") is None
            self.downloaded = True
            response = io.BytesIO(self.zip)
            response.status = 200
            return response
        assert request.get_header("Authorization") == "Bearer stub-github-token"
        if request.full_url == self.base:
            return io.BytesIO(json.dumps(self.metadata).encode())
        assert request.full_url == f"{self.base}/zip"
        raise HTTPError(request.full_url, 302, "Found", {"Location": self.location}, None)


class ArtifactTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.image = b"opaque candidate image bytes"
        self.env = {
            "ARTIFACT_ID": "501",
            "GITHUB_RUN_ID": "89",
            "GITHUB_RUN_ATTEMPT": "2",
            "PR_NUMBER": "45",
            "GIT_SHA": "b" * 40,
            "GITHUB_WORKFLOW_SHA": "a" * 40,
            "IMAGE_TAR_DIGEST": sha256(self.image),
            "GH_TOKEN": "stub-github-token",
            "RUNNER_TEMP": temporary.name,
        }

    def test_downloads_exact_artifact_bytes_and_keeps_token_out_of_redirect(self):
        provider = GitHubArtifact(self.env, self.image)
        image = Path(download_image(self.env, provider))
        self.assertEqual(image.read_bytes(), self.image)
        self.assertEqual(list(image.parent.iterdir()), [image])

    def test_rejects_wrong_run_attempt_head_repo_and_digest_before_download(self):
        for change in (
            {"id": 502}, {"name": "another-attempt"}, {"expired": True},
            {"size_in_bytes": 513 * 1024 * 1024}, {"digest": "sha256:" + "0" * 64},
        ):
            with self.subTest(change=change):
                provider = GitHubArtifact(self.env, self.image, **change)
                with self.assertRaisesRegex(InvalidArtifact, "run and attempt"):
                    download_image(self.env, provider)
                self.assertFalse(provider.downloaded)
        for change in (
            {"id": 90}, {"head_branch": "candidate"}, {"repository_id": 1},
            {"head_repository_id": 1}, {"head_sha": "c" * 40},
        ):
            with self.subTest(change=change):
                provider = GitHubArtifact(self.env, self.image)
                provider.metadata["workflow_run"].update(change)
                with self.assertRaisesRegex(InvalidArtifact, "run and attempt"):
                    download_image(self.env, provider)
                self.assertFalse(provider.downloaded)

    def test_rejects_tampered_archive_bytes_and_a_different_inner_digest(self):
        provider = GitHubArtifact(self.env, self.image)
        provider.zip = provider.zip[:-1] + b"!"
        with self.assertRaisesRegex(InvalidArtifact, "digest differs"):
            download_image(self.env, provider)
        provider = GitHubArtifact(self.env, self.image)
        self.env["IMAGE_TAR_DIGEST"] = "0" * 64
        with self.assertRaisesRegex(InvalidArtifact, "digest differs"):
            download_image(self.env, provider)

    def test_rejects_archive_paths_links_and_extra_members(self):
        symlink = ZipInfo("image.tar")
        symlink.create_system = 3
        symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
        for members in (
            [("../image.tar", self.image)], [(symlink, b"elsewhere")],
            [("image.tar", self.image), ("other.sh", b"unexpected")],
        ):
            with self.subTest(members=members):
                archive = self.directory / "artifact.zip"
                archive.write_bytes(zip_bytes(members))
                image = self.directory / "image.tar"
                with self.assertRaises(InvalidArtifact):
                    unpack_image(archive, image, sha256(self.image))
                self.assertFalse(image.exists())

    def test_registry_transfer_passes_the_archive_and_requires_a_digest(self):
        archive = self.directory / "image.tar"
        archive.write_bytes(self.image)
        output = self.directory / "output"
        crane = self.directory / "crane"
        crane.write_text(
            '#!/usr/bin/env bash\nset -euo pipefail\n'
            'if [[ "$1" == auth ]]; then\n'
            '  [[ "$2 $3 $4 $5 $6" == "login europe-west1-docker.pkg.dev --username oauth2accesstoken --password-stdin" ]]\n'
            '  [[ "$(cat)" == stub-google-token ]]\n'
            '  exit\nfi\n'
            '[[ "$1" == push && "$2" == "$IMAGE_ARCHIVE" && -f "$2" ]]\n'
            '[[ "$3" == "europe-west1-docker.pkg.dev/deskohub-workspace-sandbox/workspace-backend-preview/backend:pr-$PR_NUMBER-$GIT_SHA-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" ]]\n'
            'printf "%s\\n" "$CRANE_RESULT"\n'
        )
        crane.chmod(0o700)
        ref = "europe-west1-docker.pkg.dev/deskohub-workspace-sandbox/workspace-backend-preview/backend@sha256:" + "1" * 64
        env = {
            **os.environ, **self.env, "CRANE": str(crane), "IMAGE_ARCHIVE": str(archive),
            "GITHUB_OUTPUT": str(output), "GOOGLE_ACCESS_TOKEN": "stub-google-token", "CRANE_RESULT": ref,
        }
        script = Path(__file__).with_name("publish-image.sh")
        result = subprocess.run(["bash", script], env=env, capture_output=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(output.read_text(), f"image_ref={ref}\n")
        env["CRANE_RESULT"] = "other-registry/backend@sha256:" + "1" * 64
        result = subprocess.run(["bash", script], env=env, capture_output=True, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn(b"immutable preview image reference", result.stderr)
        self.assertEqual(output.read_text(), f"image_ref={ref}\n")


if __name__ == "__main__":
    unittest.main()
