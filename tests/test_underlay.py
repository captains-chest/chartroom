"""Underlay image view: /api/chartroom/underlay/<plan_id>."""

from pathlib import Path
import shutil

from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.chartroom.const import DOMAIN, UNDERLAY_MAX_BYTES
from custom_components.chartroom.underlay import underlay_dir

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

    # A new image of another type replaces the old file.
    resp = await client.post(URL, data=SVG, headers={"Content-Type": "image/svg+xml"})
    assert resp.status == 200
    folder: Path = underlay_dir(hass)
    assert await hass.async_add_executor_job(_names, folder) == ["ground.svg"]
    resp = await client.get(URL)
    assert resp.headers["Content-Type"] == "image/svg+xml"

    resp = await client.post(URL, data=JPEG, headers={"Content-Type": "image/jpeg"})
    assert resp.status == 200
    assert await hass.async_add_executor_job(_names, folder) == ["ground.jpg"]


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

    await ws.send_json_auto_id({"type": "chartroom/plans/delete", "plan_id": "ground"})
    assert (await ws.receive_json())["success"]
    assert (await client.get(URL)).status == 404
