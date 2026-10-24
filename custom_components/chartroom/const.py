"""Constants for Chartroom."""

from typing import Final

DOMAIN: Final = "chartroom"
NAME: Final = "Chartroom"
VERSION: Final = "0.1.0"

STORAGE_KEY: Final = f"{DOMAIN}.plans"
STORAGE_VERSION: Final = 1

PANEL_URL_PATH: Final = "chartroom"
PANEL_ELEMENT: Final = "chartroom-panel"
PANEL_TITLE: Final = "Chartroom"
PANEL_ICON: Final = "mdi:floor-plan"

STATIC_URL: Final = "/chartroom_static"
PANEL_JS: Final = "chartroom-panel.js"
CARD_JS: Final = "chartroom-card.js"

UNDERLAY_URL: Final = "/api/chartroom/underlay/{plan_id}"
UNDERLAY_DIR: Final = "chartroom_underlays"
UNDERLAY_MAX_BYTES: Final = 10 * 1024 * 1024

# Dispatcher signal sent with {"plan_id", "deleted"} after a plan is saved or deleted.
SIGNAL_PLAN_CHANGED: Final = f"{DOMAIN}_plan_changed"
