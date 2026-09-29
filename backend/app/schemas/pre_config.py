"""
文件说明：定义前置配置 API 的请求契约，包括按类型区分的卫星数量与自定义整流舱段参数。
响应结构由 `app.domain.pre_config_store` 和 `app.domain.fairing_segment` 构造，
字段含义与错误码在 docs/api/pre-config-api.md 中统一记录。
"""

from pydantic import BaseModel, ConfigDict, Field, field_validator


class SatelliteCountPayload(BaseModel):
    """描述保存某一类卫星数量时提交的内容。"""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    record_id: str = Field(min_length=1, max_length=64, description="数据管理页中的固化记录标识")
    value: int = Field(description="该类卫星的数量，必须为统一配置允许范围内的整数")

    @field_validator("record_id")
    @classmethod
    def validate_record_id(cls, value: str) -> str:
        """去除标识首尾空白并拒绝只包含空白的内容。"""

        normalized = value.strip()
        if not normalized:
            raise ValueError("卫星类型标识不能为空")
        return normalized


class FairingSegmentPayload(BaseModel):
    """描述保存并构建自定义整流舱段时提交的内容。"""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    min_radius_mm: float = Field(description="圆柱段底面半径区间最小值，单位为毫米，必须大于 0")
    max_radius_mm: float = Field(description="圆柱段底面半径区间最大值，单位为毫米，必须大于等于最小值")
    min_height_mm: float = Field(description="圆柱段高度区间最小值，单位为毫米，必须大于 0")
    max_height_mm: float = Field(description="圆柱段高度区间最大值，单位为毫米，必须大于等于最小值")
    axis_radius_mm: float | None = Field(
        default=None,
        description="可选中轴（中心杆）半径，单位为毫米；必须小于圆柱半径，缺省时沿用已保存值",
    )
    fairing_radius_mm: float = Field(
        gt=0,
        description="整流罩半径，单位为毫米；必须大于整流舱段底面半径最大值",
    )
    @field_validator("min_radius_mm", "max_radius_mm", "min_height_mm", "max_height_mm")
    @classmethod
    def validate_positive(cls, value: float) -> float:
        """拒绝非有限或非正的尺寸值，避免把无效参数交给几何内核。"""

        if not float(value) > 0:
            raise ValueError("整流舱段尺寸必须是正的有限数值")
        return float(value)

    @field_validator("fairing_radius_mm", mode="before")
    @classmethod
    def validate_fairing_radius_type(cls, value: object) -> object:
        """拒绝把布尔值当作整流罩半径。"""

        if isinstance(value, bool):
            raise ValueError("整流罩半径必须是正的有限数值")
        return value
