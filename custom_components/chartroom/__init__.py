"""Chartroom: a floor plan view for Home Assistant."""

from __future__ import annotations

from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType

from . import websocket_api
from .const import (
    CARD_JS,
    DOMAIN,
    PANEL_ELEMENT,
    PANEL_ICON,
    PANEL_JS,
    PANEL_TITLE,
    PANEL_URL_PATH,
    STATIC_URL,
    VERSION,
)
from .store import ChartroomStore
from .underlay import UnderlayView

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)
FRONTEND_DIR = Path(__file__).parent / "frontend"
DATA_STATIC = f"{DOMAIN}_static_registered"


def card_url() -> str:
    """URL of the card module, versioned so the companion apps drop old caches."""
    return f"{STATIC_URL}/{CARD_JS}?v={VERSION}"


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Register the websocket API once per run."""
    websocket_api.async_register(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Load plans, serve the frontend, add the panel and the card."""
    store = ChartroomStore(hass)
    await store.async_load()
    hass.data[DOMAIN] = store

    # Static routes cannot be removed from aiohttp, so register them once per run.
    if not hass.data.get(DATA_STATIC):
        await hass.http.async_register_static_paths(
            [StaticPathConfig(STATIC_URL, str(FRONTEND_DIR), cache_headers=False)]
        )
        hass.http.register_view(UnderlayView())
        hass.data[DATA_STATIC] = True

    # The card is loaded on every dashboard, like a Lovelace module resource.
    frontend.add_extra_js_url(hass, card_url())

    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name=PANEL_ELEMENT,
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        module_url=f"{STATIC_URL}/{PANEL_JS}?v={VERSION}",
        embed_iframe=False,
        require_admin=False,
        config={"version": VERSION},
    )
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Remove the panel and the card."""
    frontend.async_remove_panel(hass, PANEL_URL_PATH)
    frontend.remove_extra_js_url(hass, card_url())
    hass.data.pop(DOMAIN, None)
    return True
