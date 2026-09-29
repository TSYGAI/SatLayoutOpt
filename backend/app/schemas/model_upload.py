"""
文件说明：定义模型上传与设置 API 契约，支持曲面安装点、固定或自由向上轴，六向包络增量复用领域校验。
响应由领域清单构造，字段含义在 docs/api/model-upload-api.md 中统一记录。
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.domain.model_safety_clearance import default_safety_clearance, normalize_safety_clearance


class ModelBatchDeletePayload(BaseModel):
    """描述批量删除模型时提交的非空模型 ID 列表。"""

    ids: list[str] = Field(min_length=1)


class CenterOfMassPayload(BaseModel):
    """描述以 STEP 原点和当前模型单位表示的局部质心坐标。"""

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
    """描述单个模型可持久化的设备、变换、质心、安装基准和六向包络增量设置。"""

    model_config = ConfigDict(extra="forbid")

    device_name: str = Field(min_length=1, max_length=200)
    mass: float | None = Field(..., ge=0, le=1_000_000_000_000)
    model_scale: float = Field(ge=0.0001, le=1_000_000)
    model_unit: Literal["mm", "cm", "m"]
    rotation_x: Literal[0, 90, 180, 270]
    rotation_y: Literal[0, 90, 180, 270]
    rotation_z: Literal[0, 90, 180, 270]
    front_orientation: Literal["+X", "-X", "+Y", "-Y", "+Z", "-Z", "free"] = Field(
        description="向上轴向，free 表示自由、不固定朝上轴；不改变预览 XYZ 旋转，沿用历史字段名。",
    )
    center_of_mass: CenterOfMassPayload | None = None
    installation_face_id: str | None = Field(default=None, pattern=r"^FACE_\d{5}$")
    installation_point: InstallationPointPayload | None = None
    safety_clearance_mm: dict[str, float] = Field(default_factory=default_safety_clearance)

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

    @field_validator("device_name")
    @classmethod
    def validate_device_name(cls, value: str) -> str:
        """去除设备名称首尾空白并拒绝只包含空白的名称。"""

        normalized = value.strip()
        if not normalized:
            raise ValueError("设备名称不能为空")
        return normalized
