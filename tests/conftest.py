"""Shared fixtures."""

import pytest

# Import our package before the plugin, otherwise Home Assistant's test config dir shadows it.
import custom_components  # noqa: F401

pytest_plugins = "pytest_homeassistant_custom_component"


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    """Let Home Assistant load integrations from custom_components/."""
    return
