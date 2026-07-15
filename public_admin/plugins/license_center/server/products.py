from __future__ import annotations

from dataclasses import dataclass


DEFAULT_PRODUCT_ID = "ak_admin_panel"
AUTO_SELL_PRODUCT_ID = "ak_auto_sell"


@dataclass(frozen=True)
class LicenseProduct:
    product_id: str
    name: str
    description: str
    current_version: str
    billing_modes: tuple[str, ...]
    supports_offline_authorization: bool = False
    offline_authorization_ttl_seconds: int = 0

    def to_public_dict(self) -> dict[str, object]:
        return {
            "product_id": self.product_id,
            "name": self.name,
            "description": self.description,
            "current_version": self.current_version,
            "billing_modes": list(self.billing_modes),
            "supports_offline_authorization": self.supports_offline_authorization,
            "offline_authorization_ttl_seconds": self.offline_authorization_ttl_seconds,
        }


PRODUCTS: tuple[LicenseProduct, ...] = (
    LicenseProduct(
        product_id=DEFAULT_PRODUCT_ID,
        name="AK智能后台管理系统",
        description="AK智能后台管理系统",
        current_version="4.0.0",
        billing_modes=("unlimited", "per_use", "time_based"),
    ),
    LicenseProduct(
        product_id=AUTO_SELL_PRODUCT_ID,
        name="AK自动挂卖系统",
        description="AK自动挂卖系统离线授权",
        current_version="0.0.0",
        billing_modes=("unlimited", "time_based"),
        supports_offline_authorization=True,
        offline_authorization_ttl_seconds=8 * 60 * 60,
    ),
)

_PRODUCTS_BY_ID = {item.product_id: item for item in PRODUCTS}


def get_product(product_id: object, *, default: str = "") -> LicenseProduct | None:
    normalized = str(product_id or "").strip().lower() or default
    return _PRODUCTS_BY_ID.get(normalized)


def list_products() -> tuple[LicenseProduct, ...]:
    return PRODUCTS
