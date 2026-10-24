"""Setup, panel, card and unload."""

import json
from pathlib import Path

from homeassistant.components.frontend import DATA_EXTRA_MODULE_URL, DATA_PANELS
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.chartroom import card_url
from custom_components.chartroom.const import DOMAIN, PANEL_ELEMENT, PANEL_URL_PATH, VERSION

ROOT = Path(__file__).parents[1]


async def _setup(hass: HomeAssistant) -> MockConfigEntry:
    assert await async_setup_component(hass, "http", {})
    entry = MockConfigEntry(domain=DOMAIN, title="Chartroom")
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


async def test_setup_registers_panel_and_card(hass: HomeAssistant) -> None:
    entry = await _setup(hass)
    assert entry.state is ConfigEntryState.LOADED

    panel = hass.data[DATA_PANELS][PANEL_URL_PATH]
    assert panel.component_name == "custom"
    assert panel.sidebar_title == "Chartroom"
    assert panel.config["_panel_custom"]["name"] == PANEL_ELEMENT
    assert panel.config["_panel_custom"]["module_url"] == (
        f"/chartroom_static/{VERSION}/chartroom-panel.js"
    )
    assert card_url() == f"/chartroom_static/{VERSION}/chartroom-card.js"

    assert card_url() in hass.data[DATA_EXTRA_MODULE_URL].urls


async def test_unload_removes_panel_and_card(hass: HomeAssistant) -> None:
    entry = await _setup(hass)
    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.NOT_LOADED
    assert PANEL_URL_PATH not in hass.data[DATA_PANELS]
    assert card_url() not in hass.data[DATA_EXTRA_MODULE_URL].urls

    # Setting up again must not fail on the already registered static route.
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert PANEL_URL_PATH in hass.data[DATA_PANELS]


async def test_static_frontend_is_served(hass: HomeAssistant, hass_client) -> None:
    await _setup(hass)
    client = await hass_client()
    for path in ("chartroom-panel.js", "chartroom-card.js"):
        resp = await client.get(f"/chartroom_static/{VERSION}/{path}")
        assert resp.status == 200, path
        assert "customElements" in await resp.text()
    # Chunks and the worker sit under the same versioned path.
    resp = await client.get(f"/chartroom_static/{VERSION}/workers/worker.js")
    assert resp.status == 200
    # The old unversioned path is gone, so nothing can serve a stale copy from it.
    assert (await client.get("/chartroom_static/chartroom-card.js")).status == 404


def test_versions_agree() -> None:
    """The manifest, the constant and the frontend build (package.json) carry one version."""
    manifest = json.loads((ROOT / "custom_components/chartroom/manifest.json").read_text())
    package = json.loads((ROOT / "package.json").read_text())
    assert manifest["version"] == VERSION == package["version"]
    # The committed build embeds it (the prompt compares it with chartroom/info).
    shared = "".join(
        p.read_text() for p in (ROOT / "custom_components/chartroom/frontend").rglob("*.js")
    )
    assert any(f"{q}{VERSION}{q}" in shared for q in "\"'`")
