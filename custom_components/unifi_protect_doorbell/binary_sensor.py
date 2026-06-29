"""Binary sensor entities for the UniFi Protect Doorbell integration."""
from __future__ import annotations

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import DoorbellCoordinator
from .entity import DoorbellEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: DoorbellCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        [
            NvrConnectedSensor(coordinator, entry),
            StreamActiveSensor(coordinator, entry),
        ]
    )


class NvrConnectedSensor(DoorbellEntity, BinarySensorEntity):
    """True when the add-on has an active NVR connection."""

    _attr_translation_key = "nvr_connected"
    _attr_device_class = BinarySensorDeviceClass.CONNECTIVITY

    def __init__(self, coordinator: DoorbellCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry, "nvr_connected")

    @property
    def is_on(self) -> bool | None:
        return self.coordinator.data.get("status", {}).get("nvr", {}).get("connected")


class StreamActiveSensor(DoorbellEntity, BinarySensorEntity):
    """True when ffmpeg is running and the HLS playlist is available."""

    _attr_translation_key = "stream_active"
    _attr_device_class = BinarySensorDeviceClass.RUNNING

    def __init__(self, coordinator: DoorbellCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry, "stream_active")

    @property
    def is_on(self) -> bool | None:
        stream = self.coordinator.data.get("status", {}).get("stream", {})
        return stream.get("ffmpegRunning", False) and stream.get("hlsReady", False)
