"""Underlay images: an authenticated upload and download view per plan."""

from __future__ import annotations

import hashlib
from http import HTTPStatus
from pathlib import Path
import re

from aiohttp import web
from homeassistant.components.http import KEY_HASS, KEY_HASS_USER, HomeAssistantView
from homeassistant.core import HomeAssistant

from .const import UNDERLAY_DIR, UNDERLAY_MAX_BYTES, UNDERLAY_URL

PLAN_ID_RE = re.compile(r"^[a-z0-9_-]{1,64}$")
TYPES = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/svg+xml": "svg",
}
EXT_TYPES = {ext: content_type for content_type, ext in TYPES.items()}
# Served images never run scripts, even an SVG opened directly in a tab.
SAFE_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=0, must-revalidate",
}


def underlay_dir(hass: HomeAssistant) -> Path:
    """Where underlay files live: next to Home Assistant's own storage, so backups include them."""
    return Path(hass.config.path(".storage", UNDERLAY_DIR))


def _find(folder: Path, plan_id: str) -> Path | None:
    for ext in EXT_TYPES:
        path = folder / f"{plan_id}.{ext}"
        if path.is_file():
            return path
    return None


def _looks_like(content_type: str, data: bytes) -> bool:
    """Check the bytes match the declared type, so the view only ever stores images."""
    if content_type == "image/png":
        return data.startswith(b"\x89PNG\r\n\x1a\n")
    if content_type == "image/jpeg":
        return data.startswith(b"\xff\xd8\xff")
    if content_type == "image/webp":
        return data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    head = data[:4096].lstrip(b"\xef\xbb\xbf \t\r\n").lower()
    return head.startswith(b"<") and b"<svg" in head


def _write(folder: Path, plan_id: str, ext: str, data: bytes) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    for old in EXT_TYPES:
        if old != ext:
            (folder / f"{plan_id}.{old}").unlink(missing_ok=True)
    tmp = folder / f".{plan_id}.{ext}.tmp"
    tmp.write_bytes(data)
    tmp.replace(folder / f"{plan_id}.{ext}")


def _remove(folder: Path, plan_id: str) -> bool:
    removed = False
    for ext in EXT_TYPES:
        path = folder / f"{plan_id}.{ext}"
        if path.is_file():
            path.unlink()
            removed = True
    return removed


async def async_remove_underlay(hass: HomeAssistant, plan_id: str) -> bool:
    """Delete a plan's underlay file, if it has one."""
    return await hass.async_add_executor_job(_remove, underlay_dir(hass), plan_id)


class UnderlayView(HomeAssistantView):
    """GET returns a plan's underlay image; POST (admins) replaces it."""

    url = UNDERLAY_URL
    name = "api:chartroom:underlay"
    requires_auth = True

    async def get(self, request: web.Request, plan_id: str) -> web.StreamResponse:
        """Serve the stored image."""
        if not PLAN_ID_RE.match(plan_id):
            return self.json_message("Invalid plan id", HTTPStatus.BAD_REQUEST)
        hass = request.app[KEY_HASS]
        path = await hass.async_add_executor_job(_find, underlay_dir(hass), plan_id)
        if path is None:
            return self.json_message("No underlay", HTTPStatus.NOT_FOUND)
        content_type = EXT_TYPES[path.suffix[1:]]
        return web.FileResponse(path, headers={"Content-Type": content_type, **SAFE_HEADERS})

    async def post(self, request: web.Request, plan_id: str) -> web.Response:
        """Store the request body as the plan's underlay."""
        try:
            ext, body = await _read_upload(request, plan_id)
        except UploadError as err:
            return self.json_message(err.message, err.status)
        hass = request.app[KEY_HASS]
        await hass.async_add_executor_job(_write, underlay_dir(hass), plan_id, ext, body)
        version = hashlib.sha256(body).hexdigest()[:12]
        return self.json(
            {"url": f"{UNDERLAY_URL.format(plan_id=plan_id)}?v={version}", "bytes": len(body)}
        )


class UploadError(Exception):
    """A rejected upload, with the HTTP status to answer with."""

    def __init__(self, message: str, status: HTTPStatus) -> None:
        """Keep the message and status."""
        super().__init__(message)
        self.message = message
        self.status = status


async def _read_upload(request: web.Request, plan_id: str) -> tuple[str, bytes]:
    """Check who is uploading what; return the file extension and body."""
    if not request[KEY_HASS_USER].is_admin:
        raise UploadError("Admin required", HTTPStatus.FORBIDDEN)
    if not PLAN_ID_RE.match(plan_id):
        raise UploadError("Invalid plan id", HTTPStatus.BAD_REQUEST)
    content_type = request.content_type
    if (ext := TYPES.get(content_type)) is None:
        raise UploadError("Use PNG, JPEG, WebP or SVG", HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
    too_large = UploadError("Image too large", HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
    if (request.content_length or 0) > UNDERLAY_MAX_BYTES:
        raise too_large
    data = bytearray()
    async for chunk in request.content.iter_chunked(64 * 1024):
        data.extend(chunk)
        if len(data) > UNDERLAY_MAX_BYTES:
            raise too_large
    body = bytes(data)
    if not _looks_like(content_type, body):
        raise UploadError("Not a valid image", HTTPStatus.BAD_REQUEST)
    return ext, body
