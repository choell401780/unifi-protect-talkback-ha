"""Camera entity — exposes the add-on HLS stream to Home Assistant."""
from __future__ import annotations

from homeassistant.components.camera import Camera, CameraEntityFeature
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import CONF_ADDON_URL, DOMAIN
from .coordinator import DoorbellCoordinator


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: DoorbellCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([DoorbellCamera(coordinator, entry)])


class DoorbellCamera(CoordinatorEntity[DoorbellCoordinator], Camera):
    """Live camera stream backed by the add-on's LL-HLS pipeline."""

    _attr_has_entity_name = True
    _attr_translation_key = "live"
    _attr_supported_features = CameraEntityFeature.STREAM

    def __init__(
        self, coordinator: DoorbellCoordinator, entry: ConfigEntry
    ) -> None:
        CoordinatorEntity.__init__(self, coordinator)
        Camera.__init__(self)
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_camera"

    @property
    def device_info(self) -> DeviceInfo:
        status = self.coordinator.data.get("status", {})
        camera = status.get("camera") or {}
        return DeviceInfo(
            identifiers={(DOMAIN, self._entry.entry_id)},
            name=camera.get("name") or "UniFi Doorbell",
            manufacturer="Ubiquiti",
            model=camera.get("type") or "G4 Doorbell",
            configuration_url=self._entry.data[CONF_ADDON_URL],
        )

    @property
    def is_streaming(self) -> bool:
        return (
            self.coordinator.data.get("status", {})
            .get("stream", {})
            .get("hlsReady", False)
        )

    async def stream_source(self) -> str | None:
        """Return the HLS URL; None when the stream is not yet ready."""
        if not self.is_streaming:
            return None
        return self.coordinator.client.hls_url

    async def async_camera_image(
        self, width: int | None = None, height: int | None = None
    ) -> bytes | None:
        # No snapshot endpoint in the add-on.
        # HA will generate a thumbnail from the live stream instead.
        return None
