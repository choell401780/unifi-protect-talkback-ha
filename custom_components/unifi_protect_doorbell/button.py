"""Button entities for the UniFi Protect Doorbell integration."""
from __future__ import annotations

import logging

from homeassistant.components.button import ButtonEntity
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
    async_add_entities(
        [
            ClearDisplayMessageButton(coordinator, entry),
            RestartStreamButton(coordinator, entry),
        ]
    )


class ClearDisplayMessageButton(DoorbellEntity, ButtonEntity):
    """Button that clears the LCD display message."""

    _attr_translation_key = "clear_display_message"
    _attr_icon = "mdi:message-off"

    def __init__(self, coordinator: DoorbellCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry, "clear_display_message")

    @property
    def available(self) -> bool:
        settings = self.coordinator.data.get("settings", {})
        flags = settings.get("featureFlags") or {}
        return super().available and flags.get("hasLcdScreen", False)

    async def async_press(self) -> None:
        try:
            await self.coordinator.client.set_display_message(None)
            await self.coordinator.async_request_refresh()
        except CannotConnect as err:
            _LOGGER.error("Failed to clear display message: %s", err)


class RestartStreamButton(DoorbellEntity, ButtonEntity):
    """Button that restarts the HLS/ffmpeg pipeline in the add-on."""

    _attr_translation_key = "restart_stream"
    _attr_icon = "mdi:restart"

    def __init__(self, coordinator: DoorbellCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry, "restart_stream")

    async def async_press(self) -> None:
        try:
            await self.coordinator.client.restart_stream()
            await self.coordinator.async_request_refresh()
        except CannotConnect as err:
            _LOGGER.error("Failed to restart stream: %s", err)
