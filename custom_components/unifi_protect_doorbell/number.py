"""Number entities (volumes) for the UniFi Protect Doorbell integration."""
from __future__ import annotations

import logging

from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import PERCENTAGE
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .api import CannotConnect
from .const import DOMAIN
from .coordinator import DoorbellCoordinator
from .entity import DoorbellEntity

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: DoorbellCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        [
            SpeakerVolumeNumber(coordinator, entry),
            MicVolumeNumber(coordinator, entry),
            DoorbellRingVolumeNumber(coordinator, entry),
            ChimeVolumeNumber(coordinator, entry),
        ]
    )


class _VolumeBase(DoorbellEntity, NumberEntity):
    """Shared base for all volume sliders."""

    _attr_native_min_value = 0
    _attr_native_max_value = 100
    _attr_native_step = 1
    _attr_native_unit_of_measurement = PERCENTAGE
    _attr_mode = NumberMode.SLIDER


class SpeakerVolumeNumber(_VolumeBase):
    """Doorbell speaker / announcement volume (0–100 %)."""

    _attr_translation_key = "speaker_volume"
    _attr_icon = "mdi:volume-high"

    def __init__(self, coordinator: DoorbellCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry, "speaker_volume")

    @property
    def available(self) -> bool:
        settings = self.coordinator.data.get("settings", {})
        return super().available and settings.get("speakerSettings") is not None

    @property
    def native_value(self) -> float | None:
        settings = self.coordinator.data.get("settings", {})
        sp = settings.get("speakerSettings")
        return sp.get("volume") if sp else None

    async def async_set_native_value(self, value: float) -> None:
        try:
            await self.coordinator.client.update_settings(
                {"speakerSettings": {"volume": int(value)}}
            )
            await self.coordinator.async_request_refresh()
        except CannotConnect as err:
            _LOGGER.error("Failed to set speaker volume: %s", err)


class MicVolumeNumber(_VolumeBase):
    """Doorbell microphone sensitivity (0–100 %)."""

    _attr_translation_key = "mic_volume"
    _attr_icon = "mdi:microphone"

    def __init__(self, coordinator: DoorbellCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry, "mic_volume")

    @property
    def available(self) -> bool:
        settings = self.coordinator.data.get("settings", {})
        return super().available and settings.get("micVolume") is not None

    @property
    def native_value(self) -> float | None:
        return self.coordinator.data.get("settings", {}).get("micVolume")

    async def async_set_native_value(self, value: float) -> None:
        try:
            await self.coordinator.client.update_settings({"micVolume": int(value)})
            await self.coordinator.async_request_refresh()
        except CannotConnect as err:
            _LOGGER.error("Failed to set mic volume: %s", err)


class DoorbellRingVolumeNumber(_VolumeBase):
    """Doorbell internal ring volume (0–100 %)."""

    _attr_translation_key = "ring_volume"
    _attr_icon = "mdi:bell-ring"

    def __init__(self, coordinator: DoorbellCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry, "ring_volume")

    @property
    def available(self) -> bool:
        chimes = self.coordinator.data.get("chimes", {})
        return super().available and chimes.get("doorbellRing") is not None

    @property
    def native_value(self) -> float | None:
        dr = self.coordinator.data.get("chimes", {}).get("doorbellRing")
        return dr.get("ringVolume") if dr else None

    async def async_set_native_value(self, value: float) -> None:
        try:
            await self.coordinator.client.update_chime_settings(
                {"doorbellRing": {"ringVolume": int(value)}}
            )
            await self.coordinator.async_request_refresh()
        except CannotConnect as err:
            _LOGGER.error("Failed to set ring volume: %s", err)


class ChimeVolumeNumber(_VolumeBase):
    """First connected PoE chime volume (0–100 %)."""

    _attr_translation_key = "chime_volume"
    _attr_icon = "mdi:bell"

    def __init__(self, coordinator: DoorbellCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry, "chime_volume")

    def _first_chime(self) -> dict | None:
        chimes = self.coordinator.data.get("chimes", {}).get("chimes", [])
        return chimes[0] if chimes else None

    @property
    def available(self) -> bool:
        return super().available and self._first_chime() is not None

    @property
    def native_value(self) -> float | None:
        ch = self._first_chime()
        if not ch:
            return None
        cr = ch.get("cameraRing") or {}
        return cr.get("volume")

    async def async_set_native_value(self, value: float) -> None:
        ch = self._first_chime()
        if not ch:
            return
        try:
            await self.coordinator.client.update_chime_settings(
                {"chimeId": ch["id"], "chimeRing": {"cameraVolume": int(value)}}
            )
            await self.coordinator.async_request_refresh()
        except CannotConnect as err:
            _LOGGER.error("Failed to set chime volume: %s", err)
