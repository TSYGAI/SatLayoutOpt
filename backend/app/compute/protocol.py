"""文件说明：定义计算进程 v1 请求与资源契约，拒绝额外字段、无效摘要和越界资源。

JSON 承载任务数据与控制消息，包括正式包络 STL 导出；运行限制和算法默认值继续由集中 TOML 管理。
"""

import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.compute.monitoring import stage
from app.compute.config import COMPUTE_CONFIG
from app.compute.files import sha256, within


class Resource(BaseModel):
    """不可变输入的相对路径、SHA-256 与字节数，数据完整性由执行前校验保证。"""

    model_config = ConfigDict(extra="forbid", strict=True)
    path: str = Field(min_length=1)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    bytes: int = Field(ge=0)


class Request(BaseModel):
    """一个独立计算任务；input_root 只读，output_root 必须独立且此前不存在。"""

    model_config = ConfigDict(extra="forbid", strict=True)
    protocol_version: Literal[1]
    task_id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,80}$")
    operation: Literal["layout.prepare", "layout.solve", "layout.refine", "fixed.preview", "fixed.reference", "fixed.display", "preview.generate", "envelope.generate",
                       "installation.project", "envelope.preview", "envelope.export-stl", "fairing.generate",
                       "history.meshes", "history.mesh-binary", "history.export"]
    input_root: str
    output_root: str
    inputs: dict[str, Resource] = Field(min_length=1)
    payload: dict
    workers: int = Field(default=1, ge=1, le=COMPUTE_CONFIG["max_workers"])

    @field_validator("protocol_version", mode="before")
    @classmethod
    def strict_version(cls, value):
        """JSON 布尔值不能借助 Python 的整数相等规则伪装为协议版本。"""
        if type(value) is not int:
            raise ValueError("协议版本必须为整数")
        return value

    @model_validator(mode="after")
    def validate_roots(self):
        """确保输入存在、输出不覆盖已有路径且双方互不包含；不在验证中创建目录。"""
        source, target = Path(self.input_root), Path(self.output_root)
        if not source.is_absolute() or not target.is_absolute():
            raise ValueError("输入和输出根必须为绝对路径")
        source, target = source.resolve(), target.resolve()
        if not source.is_dir() or target.exists() or source.is_relative_to(target) or target.is_relative_to(source):
            raise ValueError("输入须存在，输出须为独立的新目录且不得覆盖或包含输入")
        if self.operation != "layout.solve" and self.workers != 1:
            raise ValueError("只有 layout.solve 支持数值多进程")
        return self

    def verify_inputs(self):
        """逐个核对声明资源的路径、长度和摘要，返回已验证的资源映射；任一损坏立即拒绝任务。"""
        paths = {}
        for name, reference in self.inputs.items():
            stage("校验输入资源摘要", resource=name, file=reference.path, bytes=reference.bytes)
            path = within(self.input_root, reference.path)
            if not path.is_file() or path.stat().st_size != reference.bytes or sha256(path) != reference.sha256:
                raise ValueError(f"输入资源校验失败：{name}")
            paths[name] = path
        if len(set(paths.values())) != len(paths):
            raise ValueError("同一个资源不得重复声明")
        return paths


def read_request(path):
    """读取有长度上限的 UTF-8 请求并严格解析；大几何不得内联到请求。"""
    with Path(path).open("rb") as stream:
        content = stream.read(COMPUTE_CONFIG["request_max_bytes"] + 1)
    if len(content) > COMPUTE_CONFIG["request_max_bytes"]:
        raise ValueError("计算请求超过协议长度上限")
    return Request.model_validate(json.loads(content.decode("utf-8")))
