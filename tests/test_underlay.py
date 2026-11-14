"""Underlay image view: /api/chartroom/underlay/<plan_id>."""

import hashlib
from pathlib import Path
import shutil
from unittest.mock import patch

from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.chartroom.const import (
    DOMAIN,
    STORAGE_KEY,
    STORAGE_VERSION,
    UNDERLAY_MAX_BYTES,
)
from custom_components.chartroom.underlay import async_prune_underlay, underlay_dir

PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 32
JPEG = b"\xff\xd8\xff\xe0" + b"\0" * 32
SVG = b'<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'
URL = "/api/chartroom/underlay/ground"


@pytest.fixture(autouse=True)
async def clean_underlays(hass: HomeAssistant):
    """Start and end without underlays (the test config dir is shared between tests)."""
    folder = underlay_dir(hass)
    await hass.async_add_executor_job(shutil.rmtree, folder, True)
    yield
    await hass.async_add_executor_job(shutil.rmtree, folder, True)


def _names(folder: Path) -> list[str]:
    return sorted(p.name for p in folder.iterdir()) if folder.exists() else []


async def _setup(hass: HomeAssistant) -> None:
    assert await async_setup_component(hass, "http", {})
    entry = MockConfigEntry(domain=DOMAIN)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()


async def test_upload_replace_and_serve(hass: HomeAssistant, hass_client) -> None:
    await _setup(hass)
    client = await hass_client()

    resp = await client.get(URL)
    assert resp.status == 404

    resp = await client.post(URL, data=PNG, headers={"Content-Type": "image/png"})
    assert resp.status == 200
    body = await resp.json()
    assert body["url"].startswith(f"{URL}?v=")
    assert body["bytes"] == len(PNG)

    resp = await client.get(body["url"])
    assert resp.status == 200
    assert resp.headers["Content-Type"] == "image/png"
    assert "sandbox" in resp.headers["Content-Security-Policy"]
    assert resp.headers["X-Content-Type-Options"] == "nosniff"
    assert await resp.read() == PNG

    # A new image, of another type too, is a new version; the old one stays for Undo.
    resp = await client.post(URL, data=SVG, headers={"Content-Type": "image/svg+xml"})
    assert resp.status == 200
    svg_url = (await resp.json())["url"]
    assert svg_url != body["url"]
    folder: Path = underlay_dir(hass)
    assert len(await hass.async_add_executor_job(_names, folder)) == 2
    # Without a version: the newest.
    resp = await client.get(URL)
    assert resp.headers["Content-Type"] == "image/svg+xml"
    resp = await client.get(svg_url)
    assert await resp.read() == SVG


async def test_undo_finds_the_replaced_image(hass: HomeAssistant, hass_client) -> None:
    """Each upload keeps its own URL, so a plan pointing at the old one still gets the old image."""
    await _setup(hass)
    client = await hass_client()
    first = await (await client.post(URL, data=PNG, headers={"Content-Type": "image/png"})).json()
    second = await (
        await client.post(URL, data=JPEG, headers={"Content-Type": "image/jpeg"})
    ).json()

    resp = await client.get(first["url"])
    assert resp.status == 200
    assert resp.headers["Content-Type"] == "image/png"
    assert await resp.read() == PNG
    resp = await client.get(second["url"])
    assert await resp.read() == JPEG

    # An unknown version is not found; a malformed one is rejected.
    assert (await client.get(f"{URL}?v=000000000000")).status == 404
    assert (await client.get(f"{URL}?v=../../x")).status == 400


async def test_prune_keeps_the_saved_plans_image(
    hass: HomeAssistant, hass_client, hass_ws_client
) -> None:
    await _setup(hass)
    client = await hass_client()
    ws = await hass_ws_client(hass)
    folder: Path = underlay_dir(hass)
    first = await (await client.post(URL, data=PNG, headers={"Content-Type": "image/png"})).json()
    second = await (
        await client.post(URL, data=SVG, headers={"Content-Type": "image/svg+xml"})
    ).json()

    async def save(underlay: dict | None) -> None:
        plan = {"name": "Ground", "underlay": underlay}
        await ws.send_json_auto_id(
            {"type": "chartroom/plans/save", "plan_id": "ground", "plan": plan}
        )
        assert (await ws.receive_json())["success"]

    async def prune() -> int:
        return await async_prune_underlay(hass, "ground", hass.data[DOMAIN].get_plan("ground"))

    # Undone back to the first image: the second goes.
    await save({"url": first["url"]})
    assert await prune() == 1
    assert (await client.get(first["url"])).status == 200
    assert (await client.get(second["url"])).status == 404
    assert len(await hass.async_add_executor_job(_names, folder)) == 1

    # A URL without a version keeps the newest image.
    await client.post(URL, data=JPEG, headers={"Content-Type": "image/jpeg"})
    await save({"url": URL})
    assert await prune() == 1
    assert (await client.get(URL)).headers["Content-Type"] == "image/jpeg"

    # The underlay removed: nothing is kept.
    await save(None)
    assert await prune() == 1
    assert await hass.async_add_executor_job(_names, folder) == []


async def test_startup_prunes_and_names_old_files_by_version(
    hass: HomeAssistant, hass_storage: dict
) -> None:
    """Images kept for Undo go at startup; a file from before versions is kept."""
    folder: Path = underlay_dir(hass)
    version = hashlib.sha256(PNG).hexdigest()[:12]

    def seed() -> None:
        folder.mkdir(parents=True)
        (folder / "ground.png").write_bytes(PNG)
        (folder / "ground.0123456789ab.jpg").write_bytes(JPEG)
        (folder / "gone.0123456789ab.jpg").write_bytes(JPEG)

    await hass.async_add_executor_job(seed)
    plan = {"name": "Ground", "underlay": {"url": f"{URL}?v={version}"}}
    hass_storage[STORAGE_KEY] = {
        "version": STORAGE_VERSION,
        "key": STORAGE_KEY,
        "data": {"plans": {"ground": plan}},
    }
    await _setup(hass)
    assert await hass.async_add_executor_job(_names, folder) == [f"ground.{version}.png"]


async def test_startup_keeps_an_old_file_its_plan_points_past(
    hass: HomeAssistant, hass_client, hass_storage: dict
) -> None:
    """A file from before versions keeps answering to the plan's `?v=`, even another image's.

    Replacing the image and then Undo used to save the old image's version while the file held
    the new one; the file was served for any version, so it must not be pruned as unreferenced.
    """
    folder: Path = underlay_dir(hass)
    other = hashlib.sha256(JPEG).hexdigest()[:12]

    def seed() -> None:
        folder.mkdir(parents=True)
        (folder / "ground.png").write_bytes(PNG)

    await hass.async_add_executor_job(seed)
    plan = {"name": "Ground", "underlay": {"url": f"{URL}?v={other}"}}
    hass_storage[STORAGE_KEY] = {
        "version": STORAGE_VERSION,
        "key": STORAGE_KEY,
        "data": {"plans": {"ground": plan}},
    }
    await _setup(hass)
    assert await hass.async_add_executor_job(_names, folder) == [f"ground.{other}.png"]
    resp = await (await hass_client()).get(f"{URL}?v={other}")
    assert resp.status == 200
    assert await resp.read() == PNG


async def test_no_upload_or_save_while_pruning(
    hass: HomeAssistant, hass_client, hass_ws_client
) -> None:
    """Startup prunes before saves and uploads can name an image it is about to delete."""
    seen: list[bool] = []

    async def prune(hass: HomeAssistant, plans: dict) -> None:
        seen.append(DOMAIN in hass.data)

    with patch("custom_components.chartroom.async_prune_underlays", prune):
        await _setup(hass)
    assert seen == [False]

    # Reloading: the upload view stays registered, but refuses until the store is back.
    client = await hass_client()
    store = hass.data.pop(DOMAIN)
    resp = await client.post(URL, data=PNG, headers={"Content-Type": "image/png"})
    assert resp.status == 503
    assert await hass.async_add_executor_job(_names, underlay_dir(hass)) == []
    hass.data[DOMAIN] = store
    assert (await client.post(URL, data=PNG, headers={"Content-Type": "image/png"})).status == 200


async def test_rejects_bad_uploads(hass: HomeAssistant, hass_client) -> None:
    await _setup(hass)
    client = await hass_client()

    resp = await client.post(URL, data=b"GIF89a", headers={"Content-Type": "image/gif"})
    assert resp.status == 415
    resp = await client.post(URL, data=b"hello", headers={"Content-Type": "image/png"})
    assert resp.status == 400
    resp = await client.post(URL, data=b"<html></html>", headers={"Content-Type": "image/svg+xml"})
    assert resp.status == 400
    resp = await client.post(
        "/api/chartroom/underlay/Bad.Id", data=PNG, headers={"Content-Type": "image/png"}
    )
    assert resp.status == 400
    big = PNG + b"\0" * UNDERLAY_MAX_BYTES
    resp = await client.post(URL, data=big, headers={"Content-Type": "image/png"})
    assert resp.status == 413
    assert await hass.async_add_executor_job(_names, underlay_dir(hass)) == []


async def test_requires_auth_and_admin(
    hass: HomeAssistant, hass_client, hass_client_no_auth, hass_read_only_access_token
) -> None:
    await _setup(hass)
    anonymous = await hass_client_no_auth()
    resp = await anonymous.get(URL)
    assert resp.status == 401
    resp = await anonymous.post(URL, data=PNG, headers={"Content-Type": "image/png"})
    assert resp.status == 401

    reader = await hass_client(hass_read_only_access_token)
    resp = await reader.post(URL, data=PNG, headers={"Content-Type": "image/png"})
    assert resp.status == 403

    admin = await hass_client()
    assert (await admin.post(URL, data=PNG, headers={"Content-Type": "image/png"})).status == 200
    # Readers may look at it.
    assert (await reader.get(URL)).status == 200


async def test_deleting_the_plan_removes_its_underlay(
    hass: HomeAssistant, hass_client, hass_ws_client
) -> None:
    await _setup(hass)
    client = await hass_client()
    ws = await hass_ws_client(hass)
    await ws.send_json_auto_id(
        {"type": "chartroom/plans/save", "plan_id": "ground", "plan": {"name": "Ground"}}
    )
    assert (await ws.receive_json())["success"]
    assert (await client.post(URL, data=PNG, headers={"Content-Type": "image/png"})).status == 200

    assert (
        await client.post(URL, data=SVG, headers={"Content-Type": "image/svg+xml"})
    ).status == 200

    await ws.send_json_auto_id({"type": "chartroom/plans/delete", "plan_id": "ground"})
    assert (await ws.receive_json())["success"]
    assert (await client.get(URL)).status == 404
    assert await hass.async_add_executor_job(_names, underlay_dir(hass)) == []
