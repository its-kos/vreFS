"""
handlers.py — LOCAL DEV ONLY

Two responsibilities:

1. CommunicatorHandler — proxies the NaaVRE communicator envelope to the
   vreFS backend with a fake JWT. In production, the real
   NaaVRE-communicator-jupyterlab handles this.

2. Local filesystem handlers — give the vreFS frontend access to the
   researcher's local filesystem, which the Django backend (running in
   Docker) cannot reach.
   - GET  /vrefs/local/browse    — list files/dirs at a path
   - GET  /vrefs/local/metadata  — size, MIME, checksum for a file
   - POST /vrefs/local/stage     — read a local file and push it to Django
                                   for upload to MinIO

   In production on NaaVRE, these handlers would live in the vreFS
   JupyterLab extension package itself (not in the communicator stub),
   since local filesystem access is a vreFS responsibility, not a
   communicator responsibility. They are here for local dev convenience.
"""

import hashlib
import json
import mimetypes
import os
import uuid
from pathlib import Path

import urllib.request
import urllib.error

from jupyter_server.base.handlers import APIHandler
from tornado.web import authenticated

_FAKE_JWT = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
    ".eyJzdWIiOiJ0ZXN0LXVzZXIiLCJwcmVmZXJyZWRfdXNlcm5hbWUiOiJ0ZXN0dXNlciIsImdyb3VwcyI6W119"
    ".vMyx0jYENWe-YDHlZir84bxDhcL2Se6y_WQHG3Dvl5c"
)

_BACKEND_URL = os.environ.get("VREFS_BACKEND_URL", "http://localhost:8000")


# ── 1. Communicator proxy ─────────────────────────────────────────────────────

class CommunicatorHandler(APIHandler):

    def check_xsrf_cookie(self):
        pass

    @authenticated
    def post(self):
        try:
            body = json.loads(self.request.body)
            query = body.get("query", {})
        except (json.JSONDecodeError, AttributeError):
            self.set_status(400)
            self.finish({"error": "Invalid request body"})
            return

        method = query.get("method", "GET").upper()
        url = query.get("url", "")
        headers = query.get("headers", {}) or {}
        data = query.get("data", {})

        if not url:
            self.set_status(400)
            self.finish({"error": "Missing url in query"})
            return

        headers["Authorization"] = f"Bearer {_FAKE_JWT}"
        headers["Content-Type"] = "application/json"

        request_body = None
        if method in ("POST", "PATCH", "PUT") and data:
            request_body = json.dumps(data).encode()

        req = urllib.request.Request(
            url, data=request_body, headers=headers, method=method
        )

        try:
            with urllib.request.urlopen(req) as resp:
                status = resp.status
                content = resp.read()
        except urllib.error.HTTPError as e:
            status = e.code
            content = e.read()
        except urllib.error.URLError as e:
            self.set_status(502)
            self.finish({"error": f"Cannot reach backend at {_BACKEND_URL}: {e.reason}"})
            return

        self.set_status(status)
        self.set_header("Content-Type", "application/json")
        if status != 204 and content:
            self.finish(content)
        else:
            self.finish()


# ── 2. Local filesystem handlers ──────────────────────────────────────────────

class LocalBrowseHandler(APIHandler):
    """
    GET /vrefs/local/browse?path=/some/local/path

    Lists files and directories at the given path on the researcher's
    machine. Returns the same shape as Django's browse endpoint so the
    frontend doesn't need to know which one it called.
    """

    def check_xsrf_cookie(self):
        pass

    @authenticated
    def get(self):
        path = self.get_argument("path", "")
        if not path:
            self.set_status(400)
            self.finish({"error": "path parameter required"})
            return

        p = Path(path)

        if not p.exists():
            self.set_status(404)
            self.finish({"error": f"Path does not exist: {path}"})
            return

        if not p.is_dir():
            self.set_status(400)
            self.finish({"error": f"Path is not a directory: {path}"})
            return

        entries = []
        try:
            for child in sorted(p.iterdir()):
                stat = child.stat()
                entries.append({
                    "name":     child.name,
                    "path":     str(child),
                    "type":     "directory" if child.is_dir() else "file",
                    "size":     stat.st_size if child.is_file() else 0,
                    "modified": stat.st_mtime,
                })
        except PermissionError as e:
            self.set_status(403)
            self.finish({"error": str(e)})
            return

        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(entries))


class LocalMetadataHandler(APIHandler):
    """
    GET /vrefs/local/metadata?path=/some/local/file.csv

    Returns size, MIME type, and SHA-256 checksum for a single local file.
    Used when registering a local file as a dataset so Django gets accurate
    metadata without needing to read the file itself.
    """

    def check_xsrf_cookie(self):
        pass

    @authenticated
    def get(self):
        path = self.get_argument("path", "")
        if not path:
            self.set_status(400)
            self.finish({"error": "path parameter required"})
            return

        p = Path(path)
        if not p.exists() or not p.is_file():
            self.set_status(404)
            self.finish({"error": f"File not found: {path}"})
            return

        stat = p.stat()

        sha256 = hashlib.sha256()
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                sha256.update(chunk)

        mime, _ = mimetypes.guess_type(str(p))

        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps({
            "name":             p.name,
            "path":             str(p),
            "size":             stat.st_size,
            "format":           mime or "application/octet-stream",
            "checksum_sha256":  sha256.hexdigest(),
        }))


class LocalStageHandler(APIHandler):
    """
    POST /vrefs/local/stage
    Body: { "path": "/local/file.csv", "dataset_id": "...", "workflow_run_id": "..." }

    Reads a local file and POSTs it to Django's upload endpoint
    (/api/v1/staging/upload/), which stores it in MinIO and creates a
    StagedDataset record with status='ready'.

    Returns the StagedDataset JSON from Django.

    LIMITATION (local dev): Django's MinIO is at localhost:9000.
    The extension reads the file from the researcher's machine and pushes
    it to Django via HTTP. For large files this will be slow — the same
    large-file limitation that applies to remote backends applies here too.

    IN PRODUCTION: the same flow applies but MinIO credentials and the
    upload endpoint URL would come from the NaaVRE platform configuration
    rather than being hardcoded to localhost.
    """

    def check_xsrf_cookie(self):
        pass

    @authenticated
    def post(self):
        try:
            body = json.loads(self.request.body)
        except json.JSONDecodeError:
            self.set_status(400)
            self.finish({"error": "Invalid JSON body"})
            return

        path         = body.get("path", "")
        dataset_id   = body.get("dataset_id", "")
        workflow_run = body.get("workflow_run_id", "")

        if not path or not dataset_id:
            self.set_status(400)
            self.finish({"error": "path and dataset_id required"})
            return

        p = Path(path)
        if not p.exists() or not p.is_file():
            self.set_status(404)
            self.finish({"error": f"File not found: {path}"})
            return

        with open(p, "rb") as f:
            file_data = f.read()

        # Build multipart form body for Django's upload endpoint
        boundary = uuid.uuid4().hex
        crlf = b"\r\n"

        def field(name, value):
            return (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
                f"{value}\r\n"
            ).encode()

        body_bytes = (
            field("dataset_id", dataset_id)
            + field("workflow_run_id", workflow_run)
            + (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="file"; filename="{p.name}"\r\n'
                f"Content-Type: application/octet-stream\r\n\r\n"
            ).encode()
            + file_data
            + crlf
            + f"--{boundary}--\r\n".encode()
        )

        upload_url = f"{_BACKEND_URL}/api/v1/staging/upload/"
        headers = {
            "Authorization":  f"Bearer {_FAKE_JWT}",
            "Content-Type":   f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(body_bytes)),
        }

        req = urllib.request.Request(
            upload_url, data=body_bytes, headers=headers, method="POST"
        )

        try:
            with urllib.request.urlopen(req) as resp:
                status  = resp.status
                content = resp.read()
        except urllib.error.HTTPError as e:
            status  = e.code
            content = e.read()
        except urllib.error.URLError as e:
            self.set_status(502)
            self.finish({"error": f"Cannot reach backend: {e.reason}"})
            return

        self.set_status(status)
        self.set_header("Content-Type", "application/json")
        if status != 204 and content:
            self.finish(content)
        else:
            self.finish()


# ── Route registration ────────────────────────────────────────────────────────

def setup_handlers(web_app):
    host_pattern = ".*$"
    base_url = web_app.settings["base_url"]
    handlers = [
        (f"{base_url}naavre-communicator/external-service", CommunicatorHandler),
        (f"{base_url}vrefs/local/browse",    LocalBrowseHandler),
        (f"{base_url}vrefs/local/metadata",  LocalMetadataHandler),
        (f"{base_url}vrefs/local/stage",     LocalStageHandler),
        (f"{base_url}vrefs/local/files",     LocalFilesHandler),
    ]
    web_app.add_handlers(host_pattern, handlers)


class LocalFilesHandler(APIHandler):
    """
    GET /vrefs/local/files?path=/some/directory

    Recursively lists all non-hidden files under the given path.
    Returns a flat list — directory structure is reconstructed
    client-side from the file paths. Used for:
      - Auto-indexing when a backend is registered
      - Re-syncing when the researcher hits the refresh button
    """

    def check_xsrf_cookie(self):
        pass

    @authenticated
    def get(self):
        path = self.get_argument('path', '')
        if not path:
            self.set_status(400)
            self.finish({'error': 'path parameter required'})
            return

        p = Path(path)
        if not p.exists() or not p.is_dir():
            self.set_status(404)
            self.finish({'error': f'Directory not found: {path}'})
            return

        files = []
        try:
            for child in sorted(p.rglob('*')):
                # Skip hidden files and directories at any depth
                if any(part.startswith('.') for part in child.parts):
                    continue
                if child.is_file():
                    stat = child.stat()
                    files.append({
                        'name':     child.name,
                        'path':     str(child),
                        'size':     stat.st_size,
                        'modified': stat.st_mtime,
                    })
        except PermissionError as e:
            self.set_status(403)
            self.finish({'error': str(e)})
            return

        self.set_header('Content-Type', 'application/json')
        self.finish(json.dumps(files))