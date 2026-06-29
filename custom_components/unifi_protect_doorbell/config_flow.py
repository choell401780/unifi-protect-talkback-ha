"""Config flow for the UniFi Protect Doorbell integration."""
from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import AddonApiClient, CannotConnect
from .const import CONF_ADDON_URL, CONF_VERIFY_SSL, DEFAULT_PORT, DOMAIN

_LOGGER = logging.getLogger(__name__)

_DEFAULT_URL = f"http://localhost:{DEFAULT_PORT}"

STEP_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_ADDON_URL, default=_DEFAULT_URL): str,
        vol.Optional(CONF_VERIFY_SSL, default=False): bool,
    }
)


class DoorbellConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for UniFi Protect Doorbell."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        errors: dict[str, str] = {}

        if user_input is not None:
            addon_url = user_input[CONF_ADDON_URL].rstrip("/")
            verify_ssl = user_input.get(CONF_VERIFY_SSL, False)

            session = async_get_clientsession(self.hass, verify_ssl=verify_ssl)
            client = AddonApiClient(addon_url, session, verify_ssl)

            try:
                status = await client.get_status()
            except CannotConnect:
                errors["base"] = "cannot_connect"
            except Exception:  # noqa: BLE001
                _LOGGER.exception("Unexpected error during config flow")
                errors["base"] = "unknown"
            else:
                await self.async_set_unique_id(addon_url)
                self._abort_if_unique_id_configured()

                camera_name = (status.get("camera") or {}).get("name", "UniFi Doorbell")
                return self.async_create_entry(
                    title=camera_name,
                    data={
                        CONF_ADDON_URL: addon_url,
                        CONF_VERIFY_SSL: verify_ssl,
                    },
                )

        return self.async_show_form(
            step_id="user",
            data_schema=STEP_SCHEMA,
            errors=errors,
        )
