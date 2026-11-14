"""Underlay images: an authenticated upload and download view per plan.

Each upload is kept as its own version, `<plan_id>.<version>.<ext>`, the version being the start
of the image's SHA-256, and the plan points at it with `?v=<version>`. Replacing the image so
leaves the previous one in place for the editor's Undo. Versions the stored plan no longer
points at are pruned at startup, before any upload or save can race it, and all of them when the
plan is deleted. An upload is written to a hidden temp file and moved into place; startup also
deletes the temp files an interrupted upload left behind.
"""

from __future__ import annotations

import hashlib
from http import HTTPStatus
from pathlib import Path
import re
from typing import Any
from urllib.parse import parse_qs, urlsplit

from aiohttp import web
from homeassistant.components.http import KEY_HASS, KEY_HASS_USER, HomeAssistantView
from homeassistant.core import HomeAssistant

from .const import DOMAIN, PLAN_ID_RE, UNDERLAY_DIR, UNDERLAY_MAX_BYTES, UNDERLAY_URL

UPLOAD_CHUNK_BYTES = 64 * 1024
TYPES = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/svg+xml": "svg",
}
EXT_TYPES = {ext: content_type for content_type, ext in TYPES.items()}
# The `?v=` of an image URL: the first 12 hex digits of the image's SHA-256.
VERSION_RE = re.compile(r"\A[0-9a-f]{12}\Z")
# Served images never run scripts, even an SVG opened directly in a tab.
SAFE_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=0, must-revalidate",
}


def underlay_dir(hass: HomeAssistant) -> Path:
    """Where underlay files live: next to Home Assistant's own storage, so backups include them."""
    return Path(hass.config.path(".storage", UNDERLAY_DIR))


def image_version(data: bytes) -> str:
    """Return the version an image is stored and addressed under."""
    return hashlib.sha256(data).hexdigest()[:12]


def url_version(url: Any) -> str | None:
    """Return the version a plan's underlay URL points at (`?v=`), or None."""
    if not isinstance(url, str):
        return None
    version = parse_qs(urlsplit(url).query).get("v", [""])[0]
    return version if VERSION_RE.match(version) else None


def _files(folder: Path, plan_id: str) -> dict[str | None, Path]:
    """Return a plan's image files by version; None for one from before versions."""
    found: dict[str | None, Path] = {}
    if not folder.is_dir():
        return found
    for path in folder.glob(f"{plan_id}.*"):
        parts = path.name.split(".")
        if not path.is_file() or parts[0] != plan_id or parts[-1] not in EXT_TYPES:
            continue
        if len(parts) == 2:
            found[None] = path
        elif len(parts) == 3 and VERSION_RE.match(parts[1]):
            found[parts[1]] = path
    return found


def _find(folder: Path, plan_id: str, version: str | None) -> Path | None:
    """Return the file for `version`, or the newest one without a version asked for."""
    files = _files(folder, plan_id)
    if version is None:
        return max(files.values(), key=lambda p: p.stat().st_mtime_ns, default=None)
    # A file stored before versions answers to the version its plan already points at.
    return files.get(version) or files.get(None)


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


def _is_temp(name: str) -> bool:
    """Whether `name` is an upload's temp file, `.<plan_id>.<version>.<ext>.tmp` (see _write)."""
    if not (name.startswith(".") and name.endswith(".tmp")):
        return False
    parts = name[1:-4].split(".")
    return (
        len(parts) == 3
        and PLAN_ID_RE.match(parts[0]) is not None
        and VERSION_RE.match(parts[1]) is not None
        and parts[2] in EXT_TYPES
    )


def _write(folder: Path, plan_id: str, ext: str, data: bytes) -> str:
    """Store `data` as a new version next to the plan's others; return its version."""
    folder.mkdir(parents=True, exist_ok=True)
    version = image_version(data)
    tmp = folder / f".{plan_id}.{version}.{ext}.tmp"
    try:
        tmp.write_bytes(data)
        tmp.replace(folder / f"{plan_id}.{version}.{ext}")
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return version


# Prune's `keep` for a plan whose underlay URL names no version: its newest file.
NEWEST = "newest"


def _name_by_version(folder: Path, plan_id: str, keep: str | None) -> None:
    """Rename a file from before versions to a version, so it keeps being served.

    It answered to whatever `?v=` its plan points at, and after an Undo of a replaced image that
    is not its content's version, so it takes the plan's version when there is one.
    """
    legacy = _files(folder, plan_id).get(None)
    if legacy is None:
        return
    version = keep if keep not in (None, NEWEST) else image_version(legacy.read_bytes())
    target = legacy.with_name(f"{plan_id}.{version}{legacy.suffix}")
    if target.exists():
        legacy.unlink()
    else:
        legacy.replace(target)


def _prune(folder: Path, plan_id: str, keep: str | None) -> int:
    """Delete the plan's image versions other than `keep` (all with None); return how many."""
    _name_by_version(folder, plan_id, keep)
    files = _files(folder, plan_id)
    if keep == NEWEST:
        newest = _find(folder, plan_id, None)
        keep = next((v for v, p in files.items() if p == newest), None)
    removed = 0
    for version, path in files.items():
        if version != keep:
            path.unlink(missing_ok=True)
            removed += 1
    return removed


def _plan_version(plan: dict[str, Any] | None) -> str | None:
    """Return the version to keep for a stored plan: None without an underlay."""
    underlay = plan.get("underlay") if plan else None
    if not isinstance(underlay, dict):
        return None
    return url_version(underlay.get("url")) or NEWEST


async def async_prune_underlay(
    hass: HomeAssistant, plan_id: str, plan: dict[str, Any] | None
) -> int:
    """Delete the image versions `plan` (as stored) does not point at; all of them without one."""
    return await hass.async_add_executor_job(
        _prune, underlay_dir(hass), plan_id, _plan_version(plan)
    )


async def async_prune_underlays(hass: HomeAssistant, plans: dict[str, dict[str, Any]]) -> None:
    """Prune every plan's images, and drop those of plans that no longer exist.

    Also delete the temp files interrupted uploads left behind: none can be running yet, as
    uploads are refused until the store is published after this (see UnderlayView.post).
    """

    def prune_all(folder: Path) -> None:
        names = [p.name for p in folder.iterdir()] if folder.is_dir() else []
        for name in names:
            if _is_temp(name) and (folder / name).is_file():
                (folder / name).unlink(missing_ok=True)
        owners = {name.split(".")[0] for name in names}
        for plan_id in owners | set(plans):
            if PLAN_ID_RE.match(plan_id):
                _prune(folder, plan_id, _plan_version(plans.get(plan_id)))

    await hass.async_add_executor_job(prune_all, underlay_dir(hass))


async def async_remove_underlay(hass: HomeAssistant, plan_id: str) -> bool:
    """Delete every version of a plan's underlay; return whether there was one."""
    return await async_prune_underlay(hass, plan_id, None) > 0


class UnderlayView(HomeAssistantView):
    """GET returns a plan's underlay image; POST (admins) stores a new version of it."""

    url = UNDERLAY_URL
    name = "api:chartroom:underlay"
    requires_auth = True

    async def get(self, request: web.Request, plan_id: str) -> web.StreamResponse:
        """Serve the version `?v=` names, or the newest without one."""
        if not PLAN_ID_RE.match(plan_id):
            return self.json_message("Invalid plan id", HTTPStatus.BAD_REQUEST)
        version = request.query.get("v")
        if version is not None and not VERSION_RE.match(version):
            return self.json_message("Invalid version", HTTPStatus.BAD_REQUEST)
        hass = request.app[KEY_HASS]
        path = await hass.async_add_executor_job(_find, underlay_dir(hass), plan_id, version)
        if path is None:
            return self.json_message("No underlay", HTTPStatus.NOT_FOUND)
        content_type = EXT_TYPES[path.suffix[1:]]
        return web.FileResponse(path, headers={"Content-Type": content_type, **SAFE_HEADERS})

    async def post(self, request: web.Request, plan_id: str) -> web.Response:
        """Store the request body as a new version of the plan's underlay."""
        try:
            ext, body = await _read_upload(request, plan_id)
        except UploadError as err:
            return self.json_message(err.message, err.status)
        hass = request.app[KEY_HASS]
        # Not while (re)loading: startup prunes the images the stored plans don't point at.
        if DOMAIN not in hass.data:
            return self.json_message("Chartroom is not set up", HTTPStatus.SERVICE_UNAVAILABLE)
        version = await hass.async_add_executor_job(_write, underlay_dir(hass), plan_id, ext, body)
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
    async for chunk in request.content.iter_chunked(UPLOAD_CHUNK_BYTES):
        data.extend(chunk)
        if len(data) > UNDERLAY_MAX_BYTES:
            raise too_large
    body = bytes(data)
    if not _looks_like(content_type, body):
        raise UploadError("Not a valid image", HTTPStatus.BAD_REQUEST)
    return ext, body
