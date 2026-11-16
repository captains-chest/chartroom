"""Rules the frontend holds too: tests/fixtures/contract.json, also read by frontend/test."""

import json
from pathlib import Path

import pytest

from custom_components.chartroom.const import (
    PLAN_ID_RE,
    PLAN_SCHEMA_VERSION,
    UNDERLAY_MAX_BYTES,
    UNDERLAY_URL_RE,
)
from custom_components.chartroom.underlay import TYPES, _looks_like

CONTRACT = json.loads((Path(__file__).parent / "fixtures" / "contract.json").read_text("utf-8"))


@pytest.mark.parametrize("plan_id", CONTRACT["plan_ids"]["valid"])
def test_valid_plan_ids(plan_id: str) -> None:
    """The plan ids the frontend makes are accepted."""
    assert PLAN_ID_RE.match(plan_id)


@pytest.mark.parametrize("plan_id", CONTRACT["plan_ids"]["invalid"])
def test_invalid_plan_ids(plan_id: str) -> None:
    """The plan ids the frontend refuses are refused."""
    assert not PLAN_ID_RE.match(plan_id)


@pytest.mark.parametrize("case", CONTRACT["underlay_urls"]["valid"])
def test_own_underlay_urls(case: dict[str, str]) -> None:
    """An upload's URL names its plan."""
    m = UNDERLAY_URL_RE.match(case["url"])
    assert m
    assert m["plan_id"] == case["plan_id"]


@pytest.mark.parametrize("url", CONTRACT["underlay_urls"]["invalid"])
def test_other_underlay_urls(url: str) -> None:
    """Any other URL is not an underlay."""
    assert not UNDERLAY_URL_RE.match(url)


def test_image_types_and_limits() -> None:
    """The same image types, file extensions, size limit and schema version."""
    assert CONTRACT["image_types"] == TYPES
    assert CONTRACT["underlay_max_bytes"] == UNDERLAY_MAX_BYTES
    assert CONTRACT["plan_schema_version"] == PLAN_SCHEMA_VERSION


@pytest.mark.parametrize("case", CONTRACT["image_heads"])
def test_image_heads(case: dict[str, str | bool]) -> None:
    """The upload's signature check agrees with the frontend's."""
    text = case.get("text")
    data = text.encode() if isinstance(text, str) else bytes.fromhex(str(case["hex"]))
    assert _looks_like(str(case["type"]), data) is case["ok"]
