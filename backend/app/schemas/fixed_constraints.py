"""文件说明：硬固定与优先固定组的 HTTP 契约；兼容丢弃旧偏移范围，源矩阵与镜像统一由后端展开。"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from app.domain.layout_config import LAYOUT_CONFIG


class FixedPlacementGroup(BaseModel):
    """描述一组等角侧挂或单颗居中顶部；长度为毫米、角度为度，不允许客户端提交模型矩阵。"""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, strict=True)
    group_id: str = Field(min_length=1, max_length=64, pattern=r"^[a-zA-Z0-9_-]+$")
    record_id: str = Field(min_length=1, max_length=64, pattern=r"^[a-zA-Z0-9_-]+$")
    hard_constraint: bool = True
    auto_place: bool = False
    reference_radius_mm: float | None = Field(default=None, ge=0, le=1e6)
    reference_height_mm: float | None = Field(default=None, ge=0, le=1e6)
    mount: Literal["side", "top"] = "side"
    copies: Literal[1, 2, 3, 4, 6, 8] = 1
    symmetry_mode: Literal["ring", "mirror_xoz", "mirror_yoz"] = "ring"
    angle_deg: float = Field(default=0, ge=0, lt=360)
    height_mm: float = Field(default=0, ge=-1e6, le=1e6)
    suspension_mm: float = Field(default=0, ge=0, le=1e6)
    roll_quarters: int = Field(default=0, ge=0, le=3, strict=True)
    attitude_quaternion: list[float] = Field(default_factory=lambda: [0.0, 0.0, 0.0, 1.0], min_length=4, max_length=4)
    manual_suspension_mm: float | None = Field(default=None, ge=-1e6, le=1e6)

    @model_validator(mode="before")
    @classmethod
    def discard_legacy_motion_limits(cls, value):
        """兼容旧记录和草稿中的三个偏移字段；不再使用或输出，其他未知字段仍严格拒绝。"""
        if isinstance(value, dict):
            return {key: item for key, item in value.items()
                    if key not in {"soft_angle_deg", "soft_height_mm", "soft_suspension_mm"}}
        return value

    @field_validator("attitude_quaternion")
    @classmethod
    def validate_attitude(cls, value):
        """姿态补偿采用xyzw单位四元数；拒绝缩放、零四元数和非有限数据，不接收模型矩阵。"""
        if abs(sum(component * component for component in value) - 1.0) > LAYOUT_CONFIG["orientation_tolerance"]:
            raise ValueError("姿态补偿必须是单位四元数")
        return value

    @field_validator("copies", mode="before")
    @classmethod
    def validate_copies(cls, value):
        """副本数量必须为实际整数，布尔值和小数字符串不能借用 Literal 的整数等价比较。"""
        if type(value) is not int:
            raise ValueError("副本数量必须是1、2、3、4、6或8的整数")
        return value

    @model_validator(mode="after")
    def validate_top(self):
        """顶部仅单颗居中；完整镜像为侧挂一对，拒绝用环向数量或顶面对称解释镜像。"""
        if self.symmetry_mode != "ring" and (self.mount != "side" or self.copies != 2):
            raise ValueError("镜像对称仅支持侧挂两颗，分别占用两个卫星实例")
        if self.mount == "top" and (self.copies != 1 or self.angle_deg != 0 or self.height_mm != 0):
            raise ValueError("顶部仅支持单颗居中放置")
        return self


class FixedConstraintAction(BaseModel):
    """预览接口中的原子世界轴平移，单位毫米；三轴姿态旋转动作已移除。"""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, strict=True)
    group_id: str = Field(min_length=1, max_length=64)
    instance_id: str = Field(min_length=1, max_length=80)
    kind: Literal["translate"]
    axis: Literal["x", "y", "z"]
    delta: float = Field(ge=-1e6, le=1e6)


class FixedConstraintsPayload(BaseModel):
    """携带完整放置组及锁定配置指纹；预览可选请求源坐标网格，保存不会写网格。"""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    groups: list[FixedPlacementGroup] = Field(max_length=1000)
    config_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    include_meshes: bool = Field(default=False, strict=True)
    enforce_space: bool = Field(default=False, strict=True)
    action: FixedConstraintAction | None = None
