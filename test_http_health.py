"""External, credential-free HTTP probe for the public Spine archive Worker.

This file contains only public Worker URLs and no private source or credentials.
It is executed by the repository's GitHub-hosted Ubuntu runner.
"""
import json
import unittest
import urllib.error
import urllib.request

BASE_URL = "https://spine-archive.spine-animator-f8692224.workers.dev"


def get_json(path: str) -> tuple[int, dict]:
    request = urllib.request.Request(
        BASE_URL + path,
        headers={"Accept": "application/json", "User-Agent": "SA-Public-HTTP-Health-Probe"},
        method="GET",
    )
    try:
        response = urllib.request.urlopen(request, timeout=25)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = {"raw": raw[:1000]}
        return response.status, payload


class SpineArchiveExternalHTTPHealth(unittest.TestCase):
    def test_public_manifest_health(self) -> None:
        status, payload = get_json("/health")
        print("EXTERNAL_HTTP /health:", json.dumps(
            {"status": status, "body": payload}, sort_keys=True
        ))
        self.assertEqual(status, 200, "Public archive health must return HTTP 200")
        self.assertEqual(payload.get("service"), "3spine-archive")
        self.assertEqual(payload.get("status"), "ready")
        self.assertEqual(payload.get("archivePayloads"), "uploaded")
        self.assertGreaterEqual(payload.get("archivedWorkerCount", 0), 1)

    def test_private_api_readiness_is_reported_without_credentials(self) -> None:
        status, payload = get_json("/api/health")
        print("EXTERNAL_HTTP /api/health:", json.dumps(
            {"status": status, "body": payload}, sort_keys=True
        ))
        self.assertIn(status, (200, 503), "Unexpected HTTP response from private API")
        if status == 200:
            self.assertTrue(payload.get("ok"))
            self.assertIn("privateArchive", payload)
            print("PRIVATE_ARCHIVE_READY:", payload.get("privateArchive"))
        else:
            code = payload.get("error", {}).get("code")
            self.assertIn(
                code,
                ("UPLOAD_STORAGE_UNAVAILABLE", "PRIVATE_STORAGE_UNAVAILABLE"),
                "HTTP 503 must identify the missing credential/configuration",
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
