"""Persistent storage for Chartroom plans and layouts."""

from __future__ import annotations

from typing import Any, TypedDict

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.storage import Store

from .const import STORAGE_KEY, STORAGE_VERSION, UNDERLAY_URL_RE


class InvalidPlanError(ValueError):
    """A plan the store refuses to save; the message says why."""


def underlay_problem(plan_id: str, underlay: Any) -> str | None:
    """Why a plan's underlay can't be saved, or None.

    The panel fetches the underlay with the user's token, so its URL must be this plan's own image
    view (as an upload returns it): no other host, no other path, and no other plan's image.
    """
    if underlay is None:
        return None
    if not isinstance(underlay, dict) or not isinstance(url := underlay.get("url"), str):
        return "underlay must be null or an object with a url"
    if (m := UNDERLAY_URL_RE.match(url)) is None or m["plan_id"] != plan_id:
        return f"underlay url must be /api/chartroom/underlay/{plan_id}, optionally with ?v=<hex>"
    return None


class StoredData(TypedDict):
    """Shape of the stored document."""

    plans: dict[str, dict[str, Any]]


class ChartroomStore:
    """Plans and layouts, saved in Home Assistant's .storage directory."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Create the store."""
        self._store: Store[StoredData] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._plans: dict[str, dict[str, Any]] = {}

    async def async_load(self) -> None:
        """Load plans from disk."""
        data = await self._store.async_load()
        self._plans = dict(data["plans"]) if data else {}

    @callback
    def list_plans(self) -> list[dict[str, Any]]:
        """Return a summary of every plan."""
        return [
            {"id": plan_id, "name": plan.get("name", plan_id), "floor_id": plan.get("floor_id")}
            for plan_id, plan in sorted(self._plans.items())
        ]

    @callback
    def plans(self) -> dict[str, dict[str, Any]]:
        """Every stored plan by id (a copy of the mapping; the plans themselves are shared)."""
        return dict(self._plans)

    @callback
    def get_plan(self, plan_id: str) -> dict[str, Any] | None:
        """Return one plan, or None."""
        plan = self._plans.get(plan_id)
        return None if plan is None else {"id": plan_id, **plan}

    async def async_save_plan(self, plan_id: str, plan: dict[str, Any]) -> dict[str, Any]:
        """Create or replace a plan and persist it.

        Every write goes through here, so this is where a plan's underlay URL is checked: raises
        InvalidPlanError (and changes nothing) if it isn't the plan's own image.
        """
        if problem := underlay_problem(plan_id, plan.get("underlay")):
            raise InvalidPlanError(problem)
        self._plans[plan_id] = plan
        await self._store.async_save({"plans": self._plans})
        return {"id": plan_id, **plan}

    async def async_delete_plan(self, plan_id: str) -> bool:
        """Delete a plan; return whether it existed."""
        if self._plans.pop(plan_id, None) is None:
            return False
        await self._store.async_save({"plans": self._plans})
        return True
