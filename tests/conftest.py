"""Shared fixtures."""

import logging

from homeassistant.helpers import frame
import pytest

# Import our package before the plugin, otherwise Home Assistant's test config dir shadows it.
import custom_components  # noqa: F401
from custom_components.chartroom.const import DOMAIN

pytest_plugins = "pytest_homeassistant_custom_component"


class _ChartroomReports(logging.Handler):
    """Collects Home Assistant's usage reports that blame Chartroom."""

    def __init__(self) -> None:
        super().__init__()
        self.messages: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        message = record.getMessage()
        if f"integration '{DOMAIN}'" in message:
            self.messages.append(message)


@pytest.fixture(autouse=True)
def fail_on_deprecation_reports():
    """Fail any test in which Home Assistant reports a deprecated call from Chartroom.

    Home Assistant logs each offending call site once per run, so the test that reaches it first
    fails, whatever order the tests run in.
    """
    reports = _ChartroomReports()
    logger = logging.getLogger(frame.__name__)
    logger.addHandler(reports)
    try:
        yield
    finally:
        logger.removeHandler(reports)
    if reports.messages:
        pytest.fail("\n".join(reports.messages), pytrace=False)


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(fail_on_deprecation_reports, enable_custom_integrations):
    """Let Home Assistant load integrations from custom_components/.

    Takes the deprecation guard first, so it is set up before `hass` and torn down after it,
    and catches reports from unloading and shutdown too.
    """
    return
