"""
文件说明：定义模型与包络固化存储 API 的请求契约，响应结构由固化存储领域层构造。
字段含义与错误码在 docs/api/model-store-api.md 中统一记录。
"""

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ModelStoreBatchDeletePayload(BaseModel):
    """描述批量删除固化记录时提交的非空记录标识列表。"""

    model_config = ConfigDict(extra="forbid")

    ids: list[str] = Field(min_length=1)

    @field_validator("ids")
    @classmethod
    def validate_ids(cls, values: list[str]) -> list[str]:
        """清理记录标识、拒绝空值，并按首次出现顺序去重。"""

        normalized: list[str] = []
        seen: set[str] = set()
        for value in values:
            item = value.strip()
            if not item:
                raise ValueError("固化记录标识不能为空")
            if len(item) > 64:
                raise ValueError("固化记录标识长度不能超过 64 个字符")
            if item not in seen:
                seen.add(item)
                normalized.append(item)
        return normalized


class ModelStorePayload(BaseModel):
    """描述把已上传模型及其包络固化为一条存储记录时提交的内容。"""

    model_config = ConfigDict(extra="forbid")

    model_id: str = Field(min_length=1, max_length=64)
    record_name: str | None = Field(default=None, max_length=200)

    @field_validator("model_id")
    @classmethod
    def validate_model_id(cls, value: str) -> str:
        """去除模型标识首尾空白并拒绝只包含空白的内容。"""

        normalized = value.strip()
        if not normalized:
            raise ValueError("模型标识不能为空")
        return normalized

    @field_validator("record_name")
    @classmethod
    def validate_record_name(cls, value: str | None) -> str | None:
        """去除记录名称首尾空白，空白内容按未提供处理。"""

        if value is None:
            return None
        normalized = value.strip()
        return normalized or None
