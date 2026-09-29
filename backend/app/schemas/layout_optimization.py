"""文件说明：定义布局输入和历史重命名契约；依赖统一配置，锁定参数与历史名称分开校验。"""

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.domain.layout_config import LAYOUT_CONFIG


class LayoutJobNamePayload(BaseModel):
    """校验独立的历史展示名称；去除首尾空白，拒绝空名、超长名称和额外字段。"""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=LAYOUT_CONFIG["history_name_max_length"], strict=True)


class SatelliteSelection(BaseModel):
    """服务端从前置配置生成的只读数量；质量、质心和安装面均从固化模型读取。"""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    record_id: str = Field(min_length=1, max_length=64, pattern=r"^[a-zA-Z0-9_-]+$")
    count: int = Field(ge=0, le=1000, strict=True)


class LayoutOptimizationPayload(BaseModel):
    """用户可填写的布局选项；半径步长控制完整扫描的离散间隔，不能覆盖模型或前置参数。"""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    min_suspension_mm: float = Field(ge=0, le=1e6)
    max_suspension_mm: float = Field(ge=0, le=1e6)
    radius_step_mm: float = Field(default=LAYOUT_CONFIG["radius_step_mm"], gt=0, le=1e6)
    top_enabled: bool = Field(default=False, strict=True)
    top_record_id: str | None = Field(default=None, min_length=1, max_length=64, pattern=r"^[a-zA-Z0-9_-]+$")
    config_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    notes: str = Field(default="", max_length=4000)

    @model_validator(mode="after")
    def validate_options(self):
        """拒绝倒置悬高范围及顶部开关/选择矛盾；返回已验证对象。"""
        if self.min_suspension_mm > self.max_suspension_mm:
            raise ValueError("悬高最小值不得大于最大值")
        if not self.top_enabled and self.top_record_id is not None:
            raise ValueError("未勾选顶部装载时不能指定顶部卫星")
        if self.top_enabled and self.top_record_id is None:
            raise ValueError("勾选顶部装载后请先指定顶部卫星，不会自动添加或选择")
        return self


class ResolvedLayoutParameters(BaseModel):
    """仅供领域服务使用的锁定配置快照，包含本次任务的半径扫描步长。"""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    satellites: list[SatelliteSelection] = Field(min_length=1)
    min_radius_mm: float = Field(gt=0, le=1e6)
    max_radius_mm: float = Field(gt=0, le=1e6)
    min_height_mm: float = Field(gt=0, le=1e6)
    max_height_mm: float = Field(gt=0, le=1e6)
    axis_radius_mm: float = Field(gt=0, le=1e6)
    fairing_radius_mm: float = Field(gt=0, le=1e6)
    min_suspension_mm: float = Field(ge=0, le=1e6)
    max_suspension_mm: float = Field(ge=0, le=1e6)
    radius_step_mm: float = Field(default=LAYOUT_CONFIG["radius_step_mm"], gt=0, le=1e6)
    top_enabled: bool = False
    top_record_id: str | None = None
    notes: str = Field(default="", max_length=4000)

    @model_validator(mode="after")
    def validate_intervals(self):
        """拒绝倒置区间、重复记录及空载输入，返回已验证对象；不修改任何外部状态。"""
        if self.min_radius_mm > self.max_radius_mm or self.min_height_mm > self.max_height_mm:
            raise ValueError("半径和高度的最小值不得大于最大值")
        if self.axis_radius_mm >= self.min_radius_mm:
            raise ValueError("中轴半径必须小于圆柱半径最小值")
        if self.fairing_radius_mm <= self.max_radius_mm:
            raise ValueError("整流罩半径必须大于圆柱半径最大值")
        if self.min_suspension_mm > self.max_suspension_mm:
            raise ValueError("悬高最小值不得大于最大值")
        identifiers = [item.record_id for item in self.satellites]
        if len(identifiers) != len(set(identifiers)):
            raise ValueError("卫星类型不能重复，请用数量指定同类卫星")
        if not any(item.count for item in self.satellites):
            raise ValueError("至少选择一颗卫星")
        if self.top_enabled and self.top_record_id not in {item.record_id for item in self.satellites if item.count > 0}:
            raise ValueError("顶部卫星必须由用户指定，且已在前置配置中设置正的装载数量")
        if not self.top_enabled and self.top_record_id is not None:
            raise ValueError("未勾选顶部装载时不能指定顶部卫星")
        return self
