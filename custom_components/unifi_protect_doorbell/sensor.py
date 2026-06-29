"""Sensor entities for the UniFi Protect Doorbell integration."""
from __future__ import annotations

from homeassistant.components.sensor import SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import UnitOfTime
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
            StreamStatusSensor(coordinator, entry),
            StreamRestartCountSensor(coordinator, entry),
            LastSegmentAgeSensor(coordinator, entry),
            CameraNameSensor(coordinator, entry),
            CameraStateSensor(coordinator, entry),
        ]
    )


class StreamStatusSensor(DoorbellEntity, SensorEntity):
    """Human-readable stream status: ready / starting / error."""

    _attr_translation_key = "stream_status"
    _attr_icon = "mdi:video-wireless"

    def __init__(self, coordinator: DoorbellCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry, "stream_status")

    @property
    def native_value(self) -> str:
        stream = self.coordinator.data.get("status", {}).get("stream", {})
        if stream.get("hlsReady"):
            return "ready"
        if stream.get("hlsError"):
            return "error"
        return "starting"


class StreamRestartCountSensor(DoorbellEntity, SensorEntity):
    """Number of automatic stream restarts since add-on start."""

    _attr_translation_key = "stream_restart_count"
    _attr_icon = "mdi:restart"
    _attr_state_class = SensorStateClass.TOTAL_INCREASING

    def __init__(self, coordinator: DoorbellCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry, "stream_restart_count")

    @property
    def native_value(self) -> int | None:
        return (
            self.coordinator.data.get("status", {})
            .get("stream", {})
            .get("restartCount")
        )


class LastSegmentAgeSensor(DoorbellEntity, SensorEntity):
    """Seconds since the last HLS segment was written by ffmpeg."""

    _attr_translation_key = "last_segment_age"
    _attr_native_unit_of_measurement = UnitOfTime.SECONDS
    _attr_icon = "mdi:clock-outline"

    def __init__(self, coordinator: DoorbellCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry, "last_segment_age")

    @property
    def native_value(self) -> int | None:
        return (
            self.coordinator.data.get("status", {})
            .get("stream", {})
            .get("lastSegmentAgeSec")
        )


class CameraNameSensor(DoorbellEntity, SensorEntity):
    """Name of the active camera as reported by UniFi Protect."""

    _attr_translation_key = "camera_name"
    _attr_icon = "mdi:doorbell-video"

    def __init__(self, coordinator: DoorbellCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry, "camera_name")

    @property
    def native_value(self) -> str | None:
        return (
            self.coordinator.data.get("status", {})
            .get("camera", {})
            .get("name") if self.coordinator.data.get("status", {}).get("camera") else None
        )


class CameraStateSensor(DoorbellEntity, SensorEntity):
    """Connection state of the camera as reported by UniFi Protect."""

    _attr_translation_key = "camera_state"
    _attr_icon = "mdi:lan-connect"

    def __init__(self, coordinator: DoorbellCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry, "camera_state")

    @property
    def native_value(self) -> str | None:
        cam = self.coordinator.data.get("status", {}).get("camera")
        return cam.get("state") if cam else None
