//! 文件说明：流式复用浏览器合并几何缓存，重写模型归属及清单；不复制业务设置，不把大块数组整体读入内存。
use crate::{
    error::{Error, Result},
    files,
    models::Models,
};
use serde::de::{MapAccess, Visitor};
use serde::Deserializer;
use serde_json::{value::RawValue, Value};
use std::{
    collections::HashSet,
    fmt,
    fs::{self, File},
    io::{BufReader, Read, Seek, SeekFrom, Write},
    path::Path,
};

/// 保留 JSON 对象字段原始顺序及未修改片段；容器的数组字节顺序依赖浏览器的字段遍历顺序。
struct OrderedFields(Vec<(String, Box<RawValue>)>);
impl<'de> Visitor<'de> for OrderedFields {
    type Value = Self;

    /// 提示解析器只接受对象，避免错误缓存被重写成另一种结构。
    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("预览缓存 JSON 对象")
    }

    /// 按输入顺序读取字段，重复键视为损坏，其他值保留原始编码。
    fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> std::result::Result<Self, M::Error> {
        let mut fields = vec![];
        let mut names = HashSet::new();
        while let Some((key, value)) = map.next_entry::<String, Box<RawValue>>()? {
            if !names.insert(key.clone()) {
                return Err(serde::de::Error::custom("运行预览包含重复字段"));
            }
            fields.push((key, value));
        }
        Ok(Self(fields))
    }
}

/// 仅替换指定字段且保持其他字段的字节顺序；不能通过普通 Value 重排几何字段，否则数组将错位。
fn patch_object(input: &str, replacements: &[(&str, String)]) -> Result<String> {
    let fields =
        serde_json::Deserializer::from_str(input).deserialize_map(OrderedFields(vec![]))?;
    let mut entries = vec![];
    let mut replaced = 0;
    for (name, raw) in fields.0 {
        let value = if let Some((_, value)) = replacements.iter().find(|(key, _)| *key == name) {
            replaced += 1;
            value.as_str()
        } else {
            raw.get()
        };
        entries.push(format!("{}:{value}", serde_json::to_string(&name)?));
    }
    if replaced != replacements.len() {
        return Err(Error::bad("运行预览缺少待重写字段"));
    }
    Ok(format!("{{{}}}", entries.join(",")))
}

/// 按浏览器既有格式累计二进制数组长度，拒绝不支持的类型、未对齐长度和溢出。
fn binary_size(value: &Value) -> Result<u64> {
    if value.get("$satLayoutTypedArray").is_some() {
        if !matches!(
            value["$satLayoutTypedArray"].as_str(),
            Some("Float32Array" | "Uint32Array")
        ) {
            return Err(Error::bad("运行预览数组类型不兼容"));
        }
        return value["byteLength"]
            .as_u64()
            .filter(|n| n % 4 == 0)
            .ok_or_else(|| Error::bad("运行预览数组长度无效"));
    }
    let children: Vec<_> = match value {
        Value::Object(map) => map.values().collect(),
        Value::Array(array) => array.iter().collect(),
        _ => return Ok(0),
    };
    children.into_iter().try_fold(0u64, |total, item| {
        total
            .checked_add(binary_size(item)?)
            .ok_or_else(|| Error::bad("运行预览数组长度溢出"))
    })
}

/// 重写容器元数据并流式复制原始数组；版本、来源及双 LOD 生成标识均须匹配。
fn rewrite(
    source: &Path,
    target: &Path,
    models: &Models,
    id: &str,
    donor: &str,
    signature: &Value,
) -> Result<()> {
    let mut input = BufReader::new(File::open(source)?);
    let length = input.get_ref().metadata()?.len();
    let limit = models
        .config
        .integer("backend", "model_preview_runtime_cache_max_bytes");
    let mut header = [0u8; 16];
    input.read_exact(&mut header)?;
    if &header[..9] != b"SATPREV1\0" || length > limit {
        return Err(Error::bad("运行预览容器不兼容或超过上限"));
    }
    let metadata_length = u32::from_le_bytes(header[9..13].try_into().unwrap()) as u64;
    let offset = (16 + metadata_length + 3) & !3;
    if offset > length {
        return Err(Error::bad("运行预览元数据长度无效"));
    }
    let mut original = String::new();
    (&mut input)
        .take(metadata_length)
        .read_to_string(&mut original)?;
    let metadata: Value = serde_json::from_str(&original)?;
    if metadata["generatorVersion"] != "1"
        || metadata["modelId"] != donor
        || metadata["payload"]["interactionManifest"]["generated_at"] != signature[0]
        || metadata["payload"]["previewManifest"]["generated_at"] != signature[1]
        || binary_size(&metadata)? != length - offset
    {
        return Err(Error::bad("运行预览归属、生成标识或数组长度不匹配"));
    }
    let model = models.get(id)?;
    let mut replacements = vec![];
    for (key, quality) in [
        ("interactionManifest", "interaction"),
        ("previewManifest", "detail"),
    ] {
        let manifest = models
            .current_preview(&model, quality)
            .ok_or_else(|| Error::bad("目标预览尚未就绪"))?;
        replacements.push((
            key,
            serde_json::to_string(&models.public_manifest(id, quality, manifest)?)?,
        ));
    }
    // 从原文提取 payload，避免 Value 序列化按键排序而改变 TypedArray 的解码顺序。
    let fields =
        serde_json::Deserializer::from_str(&original).deserialize_map(OrderedFields(vec![]))?;
    let payload = fields
        .0
        .iter()
        .find(|(key, _)| key == "payload")
        .ok_or_else(|| Error::bad("运行预览负载缺失"))?
        .1
        .get();
    let payload = patch_object(payload, &replacements)?;
    let bytes = patch_object(
        &original,
        &[
            ("modelId", serde_json::to_string(id)?),
            ("payload", payload),
        ],
    )?
    .into_bytes();
    let metadata_length = u32::try_from(bytes.len()).map_err(Error::bad)?;
    let new_offset = (16 + bytes.len() as u64 + 3) & !3;
    if new_offset + length - offset > limit {
        return Err(Error::bad("运行预览重写后超过上限"));
    }
    header[9..13].copy_from_slice(&metadata_length.to_le_bytes());
    let mut output = File::options().write(true).create_new(true).open(target)?;
    output.write_all(&header)?;
    output.write_all(&bytes)?;
    output.write_all(&[0u8; 3][..(new_offset - 16 - bytes.len() as u64) as usize])?;
    input.seek(SeekFrom::Start(offset))?;
    if std::io::copy(&mut input, &mut output)? != length - offset {
        return Err(Error::bad("运行预览数组复制不完整"));
    }
    output.sync_all()?;
    Ok(())
}

/// 两档都复用同一生成结果时尝试恢复可选运行缓存；临时失败不影响已发布 GLB。
pub fn restore(models: &Models, id: &str, donor: &str) -> Result<()> {
    let target_model = models.get(id)?;
    let Some(signature) = models.cache_signature(&target_model) else {
        return Ok(());
    };
    let donor_model = models.get(donor)?;
    if models.cache_signature(&donor_model).as_ref() != Some(&signature) {
        return Ok(());
    }
    let target = models.root(id).join("runtime-preview.bin");
    let source = models.root(donor).join("runtime-preview.bin");
    if target.is_file() || !source.is_file() {
        return Ok(());
    }
    let temporary = models
        .root(id)
        .join(format!(".runtime-reuse-{}", files::identifier()));
    let result = rewrite(&source, &temporary, models, id, donor, &signature)
        .and_then(|()| models.publish_cache(id, &temporary, &signature));
    let _ = fs::remove_file(&temporary);
    result
}
