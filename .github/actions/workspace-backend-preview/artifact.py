"""Read one immutable same-run image artifact without extracting archive paths."""

import hashlib
import hmac
import json
import os
import re
import stat
import sys
import tempfile
from contextlib import closing
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile


MAX_BYTES = 512 * 1024 * 1024
IMAGE_NAME = "image.tar"
REPOSITORY_ID = 1015951989
ARTIFACT_API = "https://api.github.com/repos/Deskohub/deskohub-site/actions/artifacts"


class InvalidArtifact(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def require(condition, reason):
    if not condition:
        raise InvalidArtifact(reason)


def metadata_matches(artifact, env):
    run = artifact.get("workflow_run") or {}
    digest = env["ARTIFACT_DIGEST"].removeprefix("sha256:")
    return (
        artifact.get("id") == int(env["ARTIFACT_ID"])
        and artifact.get("name")
        == f"workspace-backend-pr-{env['PR_NUMBER']}-{env['GIT_SHA']}-{env['GITHUB_RUN_ATTEMPT']}"
        and artifact.get("expired") is False
        and type(artifact.get("size_in_bytes")) is int
        and 0 < artifact["size_in_bytes"] <= MAX_BYTES
        and artifact.get("digest") == f"sha256:{digest}"
        and run.get("id") == int(env["GITHUB_RUN_ID"])
        and run.get("repository_id") == REPOSITORY_ID
        and run.get("head_repository_id") == REPOSITORY_ID
        and run.get("head_branch") == "main"
        and run.get("head_sha") == env["GITHUB_WORKFLOW_SHA"]
    )


def write_verified(source, destination, size, digest):
    require(0 < size <= MAX_BYTES, "Preview artifact exceeds the size limit.")
    hasher = hashlib.sha256()
    remaining = size
    with open(destination, "xb") as output:
        while chunk := source.read(min(remaining + 1, 1024 * 1024)):
            remaining -= len(chunk)
            require(remaining >= 0, "Preview artifact exceeds its recorded size.")
            hasher.update(chunk)
            output.write(chunk)
    require(remaining == 0, "Preview artifact size differs from its recorded size.")
    require(hmac.compare_digest(hasher.hexdigest(), digest), "Preview artifact digest differs from its recorded digest.")


def unpack_image(archive, image, digest):
    with ZipFile(archive) as zip_file:
        members = zip_file.infolist()
        require(len(members) == 1, "Preview artifact must contain a single image archive.")
        member = members[0]
        require(
            member.orig_filename == IMAGE_NAME
            and stat.S_IFMT(member.external_attr >> 16) in (0, stat.S_IFREG)
            and not member.flag_bits & 1
            and member.compress_type in (ZIP_STORED, ZIP_DEFLATED),
            "Preview artifact image entry is invalid.",
        )
        with zip_file.open(member) as content:
            write_verified(content, image, member.file_size, digest)


def download_image(env, opener):
    for key in ("ARTIFACT_ID", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "PR_NUMBER"):
        require(re.fullmatch(r"[1-9][0-9]{0,18}", env[key]), "Invalid preview artifact run identity.")
    for key in ("GIT_SHA", "GITHUB_WORKFLOW_SHA"):
        require(re.fullmatch(r"[0-9a-f]{40}", env[key]), "Invalid preview artifact commit identity.")
    require(re.fullmatch(r"(?:sha256:)?[0-9a-f]{64}", env["ARTIFACT_DIGEST"]), "Invalid artifact digest.")
    require(re.fullmatch(r"[0-9a-f]{64}", env["IMAGE_TAR_DIGEST"]), "Invalid image archive digest.")
    base = f"{ARTIFACT_API}/{env['ARTIFACT_ID']}"
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {env['GH_TOKEN']}",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    with opener.open(Request(base, headers=headers), timeout=30) as response:
        body = response.read(64 * 1024 + 1)
        require(len(body) <= 64 * 1024, "Preview artifact metadata exceeds the size limit.")
        artifact = json.loads(body)
    require(metadata_matches(artifact, env), "The image artifact is not from this workflow run and attempt.")

    try:
        with opener.open(Request(f"{base}/zip", headers=headers), timeout=30):
            raise InvalidArtifact("GitHub did not return an artifact download redirect.")
    except HTTPError as error:
        with closing(error):
            require(error.code == 302, "GitHub did not return an artifact download redirect.")
            location = error.headers.get("Location", "")
    url = urlsplit(location)
    require(
        url.scheme == "https" and url.hostname and url.username is None and url.password is None
        and url.port is None and not url.fragment,
        "GitHub returned an invalid artifact download redirect.",
    )

    directory = tempfile.mkdtemp(prefix="workspace-preview-", dir=env["RUNNER_TEMP"])
    archive = os.path.join(directory, "artifact.zip")
    image = os.path.join(directory, IMAGE_NAME)
    # The redirect is a short-lived signed URL. The GitHub token stays with
    # the GitHub API and no further redirects are accepted.
    with opener.open(Request(location), timeout=30) as response:
        require(response.status == 200, "GitHub did not return an image artifact.")
        write_verified(response, archive, artifact["size_in_bytes"], artifact["digest"].removeprefix("sha256:"))
    unpack_image(archive, image, env["IMAGE_TAR_DIGEST"])
    os.unlink(archive)
    return image


if __name__ == "__main__":
    try:
        archive_path = download_image(os.environ, build_opener(NoRedirect()))
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            output.write(f"archive={archive_path}\n")
    except Exception as error:
        # HTTP errors may include the signed URL. Only report fixed messages.
        print(str(error) if isinstance(error, InvalidArtifact) else "Preview artifact verification failed.", file=sys.stderr)
        sys.exit(1)
