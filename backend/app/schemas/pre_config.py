"""
文件说明：定义前置配置 API 契约，包括整流罩形态、安装筒区间、基座与卫星关系。
响应结构由 `app.domain.pre_config_store` 和 `app.domain.fairing_segment` 构造，
字段含义与错误码在 docs/api/pre-config-api.md 中统一记录。
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


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


class SatelliteSymmetryPayload(BaseModel):
    """保存指定类型的对称开关及模式；未传模式沿用硬约束，拒绝非法类型和额外字段。"""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    record_id: str = Field(min_length=1, max_length=64)
    enabled: bool = Field(strict=True)
    mode: Literal["hard", "soft"] = "hard"


class InstallationBasePayload(BaseModel):
    """描述基座独立尺寸；上底面范围由筒体半径派生，不接受重复输入。"""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    lower_radius_mm: float = Field(gt=0, description="基座下底面半径，单位为毫米")
    height_mm: float = Field(gt=0, description="基座高度；不包含筒体，单位为毫米")

    @field_validator("lower_radius_mm", "height_mm", mode="before")
    @classmethod
    def validate_number_type(cls, value: object) -> object:
        """拒绝用布尔值代替基座尺寸，保留有限正数检查。"""

        if isinstance(value, bool):
            raise ValueError("基座尺寸必须为数值")
        return value


class InstallationTubePayload(BaseModel):
    """描述整流罩内部安装筒的半径、高度区间和质心偏移约束。"""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    min_radius_mm: float = Field(gt=0, description="安装筒半径最小值，单位为毫米")
    max_radius_mm: float = Field(gt=0, description="安装筒半径最大值，单位为毫米")
    min_height_mm: float = Field(gt=0, description="安装筒高度最小值，单位为毫米")
    max_height_mm: float = Field(gt=0, description="安装筒高度最大值，单位为毫米")
    centroid_max_offset_mm: float = Field(gt=0, description="安装筒内质心最大偏移，单位为毫米")
    base: InstallationBasePayload | None = Field(default=None, description="筒体下方的同轴基座，缺省加载预设尺寸")

    @field_validator("min_radius_mm", "max_radius_mm", "min_height_mm", "max_height_mm", "centroid_max_offset_mm", mode="before")
    @classmethod
    def validate_number_type(cls, value: object) -> object:
        """拒绝将布尔值转换成安装筒尺寸或质心约束。"""

        if isinstance(value, bool):
            raise ValueError("安装筒参数必须是数值")
        return value

    @model_validator(mode="after")
    def validate_intervals(self) -> "InstallationTubePayload":
        """确保安装筒区间端点有序，质心约束不超过最小安装筒半径。"""

        if self.min_radius_mm > self.max_radius_mm:
            raise ValueError("安装筒半径最小值不得大于最大值")
        if self.min_height_mm > self.max_height_mm:
            raise ValueError("安装筒高度最小值不得大于最大值")
        if self.centroid_max_offset_mm >= self.min_radius_mm:
            raise ValueError("质心最大偏移必须小于安装筒半径最小值")
        return self


class FairingSegmentPayload(BaseModel):
    """描述整流罩外形、内部安装筒约束和组合构件生成参数。"""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    # 旧版平铺字段保留为可选，仅用于兼容已有客户端；新客户端应使用 installation_tube。
    min_radius_mm: float | None = Field(default=None, description="兼容旧版的安装筒半径最小值")
    max_radius_mm: float | None = Field(default=None, description="兼容旧版的安装筒半径最大值")
    min_height_mm: float | None = Field(default=None, description="兼容旧版的安装筒高度最小值")
    max_height_mm: float | None = Field(default=None, description="兼容旧版的安装筒高度最大值")
    axis_radius_mm: float | None = Field(default=None, description="兼容旧版的质心最大偏移")
    centroid_max_offset_mm: float | None = Field(default=None, description="质心最大偏移，单位为毫米")
    installation_tube: InstallationTubePayload | None = Field(default=None, description="安装筒内部圆柱参数")
    fairing_cylinder_radius_mm: float | None = Field(default=None, description="整流罩外部圆柱段半径")
    fairing_cylinder_height_mm: float | None = Field(default=None, description="整流罩外部圆柱段高度")
    fairing_radius_mm: float | None = Field(
        default=None,
        gt=0,
        description="仅兼容旧版请求的整流罩边界；新请求从整流罩各段尺寸确定外形",
    )
    fairing_form: Literal[
        "lower_cone_cylinder_upper_cone",
        "lower_cone_cylinder",
        "cylinder_upper_cone",
        "cylinder",
    ] = Field(default="cylinder", description="整流罩组合形态")
    lower_cone_lower_radius_mm: float | None = Field(default=None, description="下锥段下底面半径")
    lower_cone_upper_radius_mm: float | None = Field(default=None, description="下锥段上底面半径")
    lower_cone_height_mm: float | None = Field(default=None, description="下锥段高度")
    upper_cone_lower_radius_mm: float | None = Field(default=None, description="上锥段下底面半径")
    upper_cone_upper_radius_mm: float | None = Field(default=None, description="上锥段上底面半径")
    upper_cone_height_mm: float | None = Field(default=None, description="上锥段高度")

    @model_validator(mode="after")
    def validate_installation_source(self) -> "FairingSegmentPayload":
        """确保请求包含新的安装筒对象或完整的旧版平铺字段。"""

        if self.installation_tube is not None:
            if self.fairing_cylinder_radius_mm is None or self.fairing_cylinder_height_mm is None:
                raise ValueError("请单独提供整流罩圆柱段半径和高度")
            return self
        if any(value is None for value in (self.min_radius_mm, self.max_radius_mm, self.min_height_mm, self.max_height_mm)):
            raise ValueError("缺少安装筒参数")
        if self.fairing_radius_mm is None:
            raise ValueError("旧版请求缺少整流罩半径")
        return self
    @field_validator("min_radius_mm", "max_radius_mm", "min_height_mm", "max_height_mm")
    @classmethod
    def validate_positive(cls, value: float) -> float:
        """拒绝非有限或非正的尺寸值，避免把无效参数交给几何内核。"""

        if value is None:
            return None
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

    @field_validator("centroid_max_offset_mm", "fairing_cylinder_radius_mm", "fairing_cylinder_height_mm", mode="before")
    @classmethod
    def validate_optional_shape_number(cls, value: object) -> object:
        """拒绝把布尔值作为新分组中的数值参数。"""

        if isinstance(value, bool):
            raise ValueError("形状参数必须是数值")
        return value

    @field_validator(
        "lower_cone_lower_radius_mm",
        "lower_cone_upper_radius_mm",
        "lower_cone_height_mm",
        "upper_cone_lower_radius_mm",
        "upper_cone_upper_radius_mm",
        "upper_cone_height_mm",
    )
    @classmethod
    def validate_optional_positive(cls, value: float | None) -> float | None:
        """校验可选锥段尺寸，避免布尔值或非正数进入几何内核。"""

        if value is None:
            return None
        if not float(value) > 0:
            raise ValueError("锥段尺寸必须是正的有限数值")
        return float(value)
