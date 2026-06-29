"""UniFi Protect Doorbell — Home Assistant custom integration.

Talks to the existing HA add-on (same repo) via its local REST API.
No UniFi credentials are stored here; they live exclusively in the add-on.
"""
from __future__ import annotations

import logging

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import AddonApiClient, CannotConnect
from .const import CONF_ADDON_URL, CONF_VERIFY_SSL, DOMAIN
from .coordinator import DoorbellCoordinator

_LOGGER = logging.getLogger(__name__)

PLATFORMS = [
    "binary_sensor",
    "button",
    "camera",
    "number",
    "select",
    "sensor",
    "text",
]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up from a config entry."""
    addon_url = entry.data[CONF_ADDON_URL]
    verify_ssl = entry.data.get(CONF_VERIFY_SSL, False)

    session = async_get_clientsession(hass, verify_ssl=verify_ssl)
    client = AddonApiClient(addon_url, session, verify_ssl)
    coordinator = DoorbellCoordinator(hass, client)

    await coordinator.async_config_entry_first_refresh()

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    # ── Custom services ───────────────────────────────────────────────────────

    async def _handle_send_display_message(call: ServiceCall) -> None:
        message_text: str = call.data["message"]
        try:
            await client.set_display_message(
                {"type": "CUSTOM_MESSAGE", "text": message_text}
            )
            await coordinator.async_request_refresh()
        except CannotConnect as err:
            _LOGGER.error("send_display_message failed: %s", err)

    async def _handle_clear_display_message(call: ServiceCall) -> None:
        try:
            await client.set_display_message(None)
            await coordinator.async_request_refresh()
        except CannotConnect as err:
            _LOGGER.error("clear_display_message failed: %s", err)

    async def _handle_restart_stream(call: ServiceCall) -> None:
        try:
            await client.restart_stream()
            await coordinator.async_request_refresh()
        except CannotConnect as err:
            _LOGGER.error("restart_stream failed: %s", err)

    hass.services.async_register(
        DOMAIN,
        "send_display_message",
        _handle_send_display_message,
        schema=vol.Schema({vol.Required("message"): str}),
    )
    hass.services.async_register(
        DOMAIN,
        "clear_display_message",
        _handle_clear_display_message,
    )
    hass.services.async_register(
        DOMAIN,
        "restart_stream",
        _handle_restart_stream,
    )

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id)
        # Remove services only when the last entry is removed
        if not hass.data[DOMAIN]:
            hass.services.async_remove(DOMAIN, "send_display_message")
            hass.services.async_remove(DOMAIN, "clear_display_message")
            hass.services.async_remove(DOMAIN, "restart_stream")
    return unload_ok
