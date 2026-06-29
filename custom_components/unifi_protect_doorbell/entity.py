"""Base entity class shared by all UniFi Protect Doorbell entities."""
from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import CONF_ADDON_URL, DOMAIN
from .coordinator import DoorbellCoordinator


class DoorbellEntity(CoordinatorEntity[DoorbellCoordinator]):
    """Base class: wires device_info and unique_id from the coordinator."""

    _attr_has_entity_name = True

    def __init__(
        self,
        coordinator: DoorbellCoordinator,
        entry: ConfigEntry,
        unique_suffix: str,
    ) -> None:
        super().__init__(coordinator)
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_{unique_suffix}"

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
