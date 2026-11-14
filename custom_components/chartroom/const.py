"""Constants for Chartroom."""

import re
from typing import Final

DOMAIN: Final = "chartroom"
NAME: Final = "Chartroom"
VERSION: Final = "0.1.0"

# A plan id: also its underlay's file name, so nothing that could leave the folder.
# frontend/src/plan/constants.ts (PLAN_ID_PATTERN) holds the same rule.
_PLAN_ID: Final = r"[a-z0-9_-]{1,64}"
PLAN_ID_RE: Final = re.compile(rf"\A{_PLAN_ID}\Z")

# STORAGE_VERSION versions the Store file around the plans; PLAN_SCHEMA_VERSION versions each
# plan inside it (frontend/src/plan.ts). They change independently.
STORAGE_KEY: Final = f"{DOMAIN}.plans"
STORAGE_VERSION: Final = 1
# The plan schema_version this build accepts on save. The plan schema and its migrations live in
# the frontend (normalizePlan); a plan without the field predates it and counts as this version.
PLAN_SCHEMA_VERSION: Final = 1

PANEL_URL_PATH: Final = "chartroom"
PANEL_ELEMENT: Final = "chartroom-panel"
PANEL_TITLE: Final = "Chartroom"
PANEL_ICON: Final = "mdi:floor-plan"

STATIC_URL: Final = "/chartroom_static"
PANEL_JS: Final = "chartroom-panel.js"
CARD_JS: Final = "chartroom-card.js"

UNDERLAY_URL: Final = "/api/chartroom/underlay/{plan_id}"
# The only URL a plan's underlay may have: the image view's, as an upload returns it. The panel
# fetches it with the user's token, so it must never point anywhere else (underlayPlanId in
# frontend/src/underlay-url.ts holds the same rule).
UNDERLAY_URL_RE: Final = re.compile(
    rf"\A/api/chartroom/underlay/(?P<plan_id>{_PLAN_ID})(?:\?v=[0-9a-f]{{1,64}})?\Z"
)
UNDERLAY_DIR: Final = "chartroom_underlays"
UNDERLAY_MAX_BYTES: Final = 10 * 1024 * 1024

# Dispatcher signal sent with {"plan_id", "deleted"} after a plan is saved or deleted.
SIGNAL_PLAN_CHANGED: Final = f"{DOMAIN}_plan_changed"
