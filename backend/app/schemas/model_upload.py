"""
文件说明：定义模型上传与设置 API 契约；六向增量和各模型体素分辨率复用领域校验。
响应由领域清单构造，字段含义在 docs/api/model-upload-api.md 中统一记录。
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.domain.model_safety_clearance import default_safety_clearance, normalize_safety_clearance
from app.domain.model_envelope_settings import default_envelope_settings, normalize_envelope_settings
from app.domain.coordinate_frame import default_coordinate_frame, normalize_coordinate_frame


class ModelBatchDeletePayload(BaseModel):
    """描述批量删除模型时提交的非空模型 ID 列表。"""

    ids: list[str] = Field(min_length=1)


class CenterOfMassPayload(BaseModel):
    """描述以当前模型坐标系及模型单位表示的质心；替换坐标系时填写数值保留。"""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    x: float
    y: float
    z: float


class InstallationPointPayload(BaseModel):
    """描述用户在 STEP 安装面上点击的源模型局部坐标；曲面必须提供该点。"""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    x: float
    y: float
    z: float


class ModelSettingsPayload(BaseModel):
    """描述单个模型可持久化的设备、变换、安装基准、六向增量及包络计算设置。"""

    model_config = ConfigDict(extra="forbid")

    device_name: str = Field(min_length=1, max_length=200)
    mass: float | None = Field(..., ge=0, le=1_000_000_000_000)
    model_scale: float = Field(ge=0.0001, le=1_000_000)
    model_unit: Literal["mm", "cm", "m"]
    rotation_x: Literal[0, 90, 180, 270]
    rotation_y: Literal[0, 90, 180, 270]
    rotation_z: Literal[0, 90, 180, 270]
    coordinate_frame: dict = Field(default_factory=default_coordinate_frame)
    expected_settings: dict | None = None
    front_orientation: Literal["+X", "-X", "+Y", "-Y", "+Z", "-Z", "free"] = Field(
        description="向上轴向，free 表示自由、不固定朝上轴；不改变预览 XYZ 旋转，沿用历史字段名。",
    )
    center_of_mass: CenterOfMassPayload | None = None
    installation_face_id: str | None = Field(default=None, pattern=r"^FACE_\d{5}$")
    installation_point: InstallationPointPayload | None = None
    safety_clearance_mm: dict[str, float] = Field(default_factory=default_safety_clearance)
    envelope_settings: dict[str, int] = Field(default_factory=default_envelope_settings)

    @field_validator("envelope_settings", mode="before")
    @classmethod
    def validate_envelope_settings(cls, value: object) -> dict[str, int]:
        """复用领域规则校验每模型分辨率，拒绝空值、布尔值、浮点数和数值字符串。"""

        return normalize_envelope_settings(value)

    @model_validator(mode="after")
    def validate_installation_reference(self):
        """拒绝没有安装面的孤立安装点；曲面是否必须有点由 STEP 精确校验决定。"""

        if self.installation_face_id is None and self.installation_point is not None:
            raise ValueError("未选择安装面时不能设置安装点")
        return self

    @field_validator("safety_clearance_mm", mode="before")
    @classmethod
    def validate_safety_clearance(cls, value: object) -> dict[str, float]:
        """复用领域规则校验完整六向设置，拒绝空值、布尔值及非数值输入。"""

        return normalize_safety_clearance(value)

    @field_validator("coordinate_frame", mode="before")
    @classmethod
    def validate_coordinate_frame(cls, value: object) -> dict:
        """校验相对初始 STEP 定义的当前模型坐标系。"""

        return normalize_coordinate_frame(value)

    @field_validator("device_name")
    @classmethod
    def validate_device_name(cls, value: str) -> str:
        """去除设备名称首尾空白并拒绝只包含空白的名称。"""

        normalized = value.strip()
        if not normalized:
            raise ValueError("设备名称不能为空")
        return normalized
