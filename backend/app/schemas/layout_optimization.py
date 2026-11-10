"""文件说明：定义布局输入、任务独立搜索参数与软硬对称契约；锁定基座和罩体尺寸并校验完整优化范围。"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, model_validator

from app.domain.layout_config import LAYOUT_CONFIG
from app.domain.installation_tube import normalize_installation_base
from app.schemas.fixed_constraints import FixedPlacementGroup
from app.schemas.pre_config import InstallationBasePayload


class LayoutJobNamePayload(BaseModel):
    """校验独立的历史展示名称；去除首尾空白，拒绝空名、超长名称和额外字段。"""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=LAYOUT_CONFIG["history_name_max_length"], strict=True)


class SatelliteSelection(BaseModel):
    """服务端从前置配置生成的只读数量；质量、质心和安装面均从固化模型读取。"""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    record_id: str = Field(min_length=1, max_length=64, pattern=r"^[a-zA-Z0-9_-]+$")
    count: int = Field(ge=0, le=1000, strict=True)
    symmetry_enabled: bool = Field(default=False, strict=True)
    symmetry_mode: Literal["hard", "soft"] = "hard"


class LayoutOptimizationPayload(BaseModel):
    """校验用户填写的搜索和安装选项；次数受服务端上限约束，不能覆盖模型或前置参数。"""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    min_suspension_mm: float = Field(ge=0, le=1e6)
    max_suspension_mm: float = Field(ge=0, le=1e6)
    radius_step_mm: float = Field(default=LAYOUT_CONFIG["radius_step_mm"], gt=0, le=1e6)
    hybrid_attempt_budget: int = Field(default=LAYOUT_CONFIG["hybrid_attempt_budget"], ge=1,
                                       le=LAYOUT_CONFIG["max_attempts_per_round"], strict=True)
    alns_budget_fraction: float = Field(default=LAYOUT_CONFIG["alns_budget_fraction"], ge=0, lt=1, strict=True)
    hybrid_radius_samples: int = Field(default=LAYOUT_CONFIG["hybrid_radius_samples"], ge=1, strict=True)
    cp_partition_limit: int = Field(default=LAYOUT_CONFIG["cp_partition_limit"], ge=1, strict=True)
    candidate_limit: int = Field(default=LAYOUT_CONFIG["candidate_limit"], ge=1,
                                 le=LAYOUT_CONFIG["candidate_archive_limit"], strict=True)
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
    """领域快照保存任务搜索参数；旧快照缺项时沿用运行配置，私有释放标志仅用于阶段副本。"""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    _release_soft_fixed: bool = PrivateAttr(default=False)
    satellites: list[SatelliteSelection] = Field(min_length=1)
    fixed_groups: list[FixedPlacementGroup] = Field(default_factory=list)
    min_radius_mm: float = Field(gt=0, le=1e6)
    max_radius_mm: float = Field(gt=0, le=1e6)
    min_height_mm: float = Field(gt=0, le=1e6)
    max_height_mm: float = Field(gt=0, le=1e6)
    axis_radius_mm: float = Field(gt=0, le=1e6)
    fairing_radius_mm: float = Field(gt=0, le=1e6)
    installation_base: InstallationBasePayload
    fairing_profile: dict
    min_suspension_mm: float = Field(ge=0, le=1e6)
    max_suspension_mm: float = Field(ge=0, le=1e6)
    radius_step_mm: float = Field(default=LAYOUT_CONFIG["radius_step_mm"], gt=0, le=1e6)
    hybrid_attempt_budget: int | None = Field(default=None, ge=1,
                                              le=LAYOUT_CONFIG["max_attempts_per_round"], strict=True)
    alns_budget_fraction: float | None = Field(default=None, ge=0, lt=1, strict=True)
    hybrid_radius_samples: int | None = Field(default=None, ge=1, strict=True)
    cp_partition_limit: int | None = Field(default=None, ge=1, strict=True)
    candidate_limit: int | None = Field(default=None, ge=1,
                                        le=LAYOUT_CONFIG["candidate_archive_limit"], strict=True)
    random_seed: int = Field(default=LAYOUT_CONFIG["random_seed"], ge=0,
                             le=LAYOUT_CONFIG["random_seed_max"], strict=True)
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
        if self.fairing_radius_mm < self.max_radius_mm:
            raise ValueError("整流罩半径不得小于圆柱半径最大值")
        normalize_installation_base(self.installation_base.model_dump(), self.min_radius_mm,
                                    self.max_radius_mm, self.max_height_mm,
                                    self.fairing_radius_mm, self.fairing_profile)
        if self.min_suspension_mm > self.max_suspension_mm:
            raise ValueError("悬高最小值不得大于最大值")
        identifiers = [item.record_id for item in self.satellites]
        if len(identifiers) != len(set(identifiers)):
            raise ValueError("卫星类型不能重复，请用数量指定同类卫星")
        if not any(item.count for item in self.satellites):
            raise ValueError("至少选择一颗卫星")
        if self.top_enabled and self.top_record_id not in {item.record_id for item in self.satellites if item.count > 0}:
            raise ValueError("顶部卫星必须由用户指定，且已在前置配置中设置正的装载数量")
        if self.top_enabled and any(item.record_id == self.top_record_id and item.symmetry_enabled
                                    and item.symmetry_mode == "hard"
                                    and item.count % 2 == 0 for item in self.satellites):
            raise ValueError("启用两两对称的偶数数量类型不能单独取一颗放在顶部；请更换顶部类型或关闭该类型对称")
        if not self.top_enabled and self.top_record_id is not None:
            raise ValueError("未勾选顶部装载时不能指定顶部卫星")
        return self
