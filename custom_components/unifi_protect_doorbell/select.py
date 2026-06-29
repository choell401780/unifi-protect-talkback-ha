"""Select entity (ringtone) for the UniFi Protect Doorbell integration."""
from __future__ import annotations

import logging

from homeassistant.components.select import SelectEntity
from homeassistant.config_entries import ConfigEntry
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
    async_add_entities([RingtoneSelect(coordinator, entry)])


class RingtoneSelect(DoorbellEntity, SelectEntity):
    """Dropdown to pick the doorbell internal ringtone."""

    _attr_translation_key = "ringtone"
    _attr_icon = "mdi:music-note"

    def __init__(self, coordinator: DoorbellCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry, "ringtone")

    def _ringtones(self) -> list[dict]:
        return self.coordinator.data.get("chimes", {}).get("ringtones", [])

    def _doorbell_ring(self) -> dict | None:
        return self.coordinator.data.get("chimes", {}).get("doorbellRing")

    @property
    def available(self) -> bool:
        return (
            super().available
            and bool(self._ringtones())
            and self._doorbell_ring() is not None
        )

    @property
    def options(self) -> list[str]:
        return [rt["name"] for rt in self._ringtones()]

    @property
    def current_option(self) -> str | None:
        dr = self._doorbell_ring()
        if not dr:
            return None
        current_id = dr.get("ringtoneId", "")
        for rt in self._ringtones():
            if rt["id"] == current_id:
                return rt["name"]
        return None

    async def async_select_option(self, option: str) -> None:
        ringtone_id = next(
            (rt["id"] for rt in self._ringtones() if rt["name"] == option), None
        )
        if ringtone_id is None:
            _LOGGER.warning("Unknown ringtone option: %s", option)
            return
        try:
            await self.coordinator.client.update_chime_settings(
                {"doorbellRing": {"ringtoneId": ringtone_id}}
            )
            await self.coordinator.async_request_refresh()
        except CannotConnect as err:
            _LOGGER.error("Failed to set ringtone: %s", err)
