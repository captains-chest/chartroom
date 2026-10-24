"""Brand images meet the Home Assistant brand image specification."""

from pathlib import Path

from PIL import Image
import pytest

BRAND = Path(__file__).parents[1] / "custom_components" / "chartroom" / "brand"


@pytest.mark.parametrize(
    ("name", "size"),
    [("icon.png", 256), ("icon@2x.png", 512), ("dark_icon.png", 256), ("dark_icon@2x.png", 512)],
)
def test_brand_icon(name: str, size: int) -> None:
    with Image.open(BRAND / name) as image:
        assert image.format == "PNG"
        assert image.size == (size, size)
        assert image.mode == "RGBA"
        # Transparent background, trimmed: the corners are clear and the art reaches every edge.
        assert image.getpixel((0, 0))[3] == 0
        assert image.getchannel("A").getbbox() == (0, 0, size, size)
