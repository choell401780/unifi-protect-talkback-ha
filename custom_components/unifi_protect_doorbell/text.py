"""Text entity (LCD display message) for the UniFi Protect Doorbell integration."""
from __future__ import annotations

import logging

from homeassistant.components.text import TextEntity, TextMode
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
    async_add_entities([DisplayMessageText(coordinator, entry)])


class DisplayMessageText(DoorbellEntity, TextEntity):
    """Text field for the doorbell LCD display message.

    Unavailable when the camera model has no LCD screen
    (featureFlags.hasLcdScreen == false).
    """

    _attr_translation_key = "display_message"
    _attr_icon = "mdi:message-text"
    _attr_mode = TextMode.TEXT
    _attr_native_min = 0
    _attr_native_max = 64

    def __init__(self, coordinator: DoorbellCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry, "display_message")

    @property
    def available(self) -> bool:
        settings = self.coordinator.data.get("settings", {})
        flags = settings.get("featureFlags") or {}
        return super().available and flags.get("hasLcdScreen", False)

    @property
    def native_value(self) -> str | None:
        settings = self.coordinator.data.get("settings", {})
        msg = settings.get("lcdMessage") or {}
        return msg.get("text", "")

    async def async_set_value(self, value: str) -> None:
        try:
            if value:
                await self.coordinator.client.set_display_message(
                    {"type": "CUSTOM_MESSAGE", "text": value}
                )
            else:
                await self.coordinator.client.set_display_message(None)
            await self.coordinator.async_request_refresh()
        except CannotConnect as err:
            _LOGGER.error("Failed to set display message: %s", err)
