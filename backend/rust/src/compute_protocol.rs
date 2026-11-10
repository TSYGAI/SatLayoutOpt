//! 文件说明：独立计算的严格 NDJSON 分帧与事件身份验证；不启动进程、不访问业务数据库。
use crate::error::{Error, Result};
use bytes::BytesMut;
use serde_json::Value;
use tokio_util::codec::{Decoder, LinesCodec, LinesCodecError};

/// 在有界 UTF-8 行解析上禁止 EOF 时接受未换行的半帧。
pub struct EventCodec(LinesCodec);
impl EventCodec {
    /// 以集中配置中的字节上限创建协议解析器。
    pub fn new(limit: usize) -> Self {
        Self(LinesCodec::new_with_max_length(limit))
    }
}
impl Decoder for EventCodec {
    type Item = String;
    type Error = LinesCodecError;
    /// 消费一个完整事件；长度和 UTF-8 错误由底层解析器报告。
    fn decode(
        &mut self,
        buffer: &mut BytesMut,
    ) -> std::result::Result<Option<String>, Self::Error> {
        self.0.decode(buffer)
    }
    /// 管道关闭必须刚好位于帧边界，否则按协议损坏处理。
    fn decode_eof(
        &mut self,
        buffer: &mut BytesMut,
    ) -> std::result::Result<Option<String>, Self::Error> {
        if let Some(line) = self.decode(buffer)? {
            return Ok(Some(line));
        }
        if !buffer.is_empty() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "计算事件缺少结束换行",
            )
            .into());
        }
        Ok(None)
    }
}

/// 校验事件字段、单调序号、唯一启动及终态；资源摘要在宿主中单独验证。
pub fn validate_event(
    event: &Value,
    task_id: &str,
    operation: &str,
    sequence: u64,
    ended: bool,
) -> Result<()> {
    if event.as_object().map(|o| o.len()) != Some(5)
        || event["protocol_version"].as_u64() != Some(1)
        || event["task_id"] != task_id
        || event["sequence"].as_u64() != Some(sequence)
        || !event["data"].is_object()
        || ended
    {
        return Err(Error::bad("计算事件版本、标识、顺序或终态无效"));
    }
    let kind = event["type"].as_str().unwrap_or("");
    if (sequence == 1) != (kind == "started")
        || ![
            "started",
            "progress",
            "candidates",
            "completed",
            "cancelled",
            "failed",
        ]
        .contains(&kind)
    {
        return Err(Error::bad("未知计算事件或重复启动"));
    }
    if kind == "started"
        && (event["data"]["operation"] != operation
            || event["data"]["pid"].as_u64().unwrap_or(0) == 0)
    {
        return Err(Error::bad("计算启动身份不匹配"));
    }
    Ok(())
}
