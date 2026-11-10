//! 文件说明：资源摘要、缓冲 JSON 读取、受限路径与原子发布；只操作调用方明确指定的本地文件。
use crate::error::{Error, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{BufReader, Read, Write},
    path::{Component, Path, PathBuf},
};

/// 生成无分隔符的随机记录/暂存标识。
pub fn identifier() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}
/// 生成兼容历史的 UTC ISO 时间戳。
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, false)
}
/// 校验业务标识避免借数据库字段或 URL 越出数据根。
pub fn safe_id(value: &str) -> Result<&str> {
    if value.is_empty()
        || value.len() > 200
        || !value
            .bytes()
            .all(|x| x.is_ascii_alphanumeric() || x == b'_' || x == b'-')
    {
        return Err(Error::bad("无效标识"));
    }
    Ok(value)
}
/// 限制相对资源路径并拒绝符号链接跳出根；允许尚未生成的普通子路径。
pub fn within(root: &Path, relative: &str) -> Result<PathBuf> {
    let _logging_step = crate::monitoring::Step::new("files::within", serde_json::json!({}));
    let path = Path::new(relative);
    if relative.is_empty()
        || path
            .components()
            .any(|x| !matches!(x, Component::Normal(_)))
    {
        return Err(Error::bad("资源路径越界"));
    }
    let joined = root.join(path);
    let mut parent = joined.as_path();
    while !parent.exists() {
        parent = parent
            .parent()
            .ok_or_else(|| Error::bad("资源路径无父目录"))?;
    }
    if !fs::canonicalize(parent)?.starts_with(fs::canonicalize(root)?) {
        return Err(Error::bad("资源链接越界"));
    }
    Ok(joined)
}
/// 流式读取摘要，不把大模型整体加载进内存。
pub fn hash(path: &Path) -> Result<String> {
    let _logging_step =
        crate::monitoring::Step::new("files::hash", serde_json::json!({"path":path}));
    let mut reader = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let n = reader.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
/// 计算小型结构的确定性指纹；serde_json 默认按键排序。
pub fn fingerprint(value: &Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).expect("JSON 值可序列化"))
    )
}
/// 缓冲读取 UTF-8 JSON，避免解析大型面清单时逐字节访问磁盘；文件或格式错误原样返回。
pub fn read_json(path: &Path) -> Result<Value> {
    let _logging_step =
        crate::monitoring::Step::new("files::read_json", serde_json::json!({"path":path}));
    Ok(serde_json::from_reader(BufReader::new(File::open(path)?))?)
}
/// 用原子文件替换保证索引不会被半写入截断；Windows 使用系统替换语义。
pub fn replace(source: &Path, target: &Path) -> Result<()> {
    let _logging_step = crate::monitoring::Step::new(
        "files::replace",
        serde_json::json!({"source":source,"target":target}),
    );
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let a: Vec<_> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let b: Vec<_> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe {
            MoveFileExW(
                a.as_ptr(),
                b.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    #[cfg(not(windows))]
    fs::rename(source, target)?;
    Ok(())
}
/// 先同步完整临时数据，再原子发布 JSON；失败清理当前临时文件。
pub fn write_json(path: &Path, value: &Value) -> Result<()> {
    let _logging_step =
        crate::monitoring::Step::new("files::write_json", serde_json::json!({"path":path}));
    fs::create_dir_all(path.parent().ok_or_else(|| Error::bad("缺少父目录"))?)?;
    let tmp = path.with_extension(format!("{}.tmp", identifier()));
    let result = (|| {
        let mut file = File::create(&tmp)?;
        file.write_all(&serde_json::to_vec_pretty(value)?)?;
        file.sync_all()?;
        replace(&tmp, path)
    })();
    let _ = fs::remove_file(tmp);
    result
}
/// 按原文件修改时间复制不可变输入，以维持旧预览清单的纳秒指纹。
pub fn copy(source: &Path, target: &Path) -> Result<()> {
    let _logging_step = crate::monitoring::Step::new(
        "files::copy",
        serde_json::json!({"source":source,"target":target}),
    );
    fs::create_dir_all(target.parent().ok_or_else(|| Error::bad("缺少目标目录"))?)?;
    let stamp = fs::metadata(source)?.modified()?;
    fs::copy(source, target)?;
    File::options()
        .write(true)
        .open(target)?
        .set_times(fs::FileTimes::new().set_modified(stamp))?;
    Ok(())
}
/// 构造协议资源引用；路径总是相对于指定根。
pub fn reference(root: &Path, path: &Path) -> Result<Value> {
    let _logging_step =
        crate::monitoring::Step::new("files::reference", serde_json::json!({"path":path}));
    Ok(
        json!({"path": path.strip_prefix(root).map_err(Error::bad)?.to_string_lossy().replace('\\', "/"), "bytes": fs::metadata(path)?.len(), "sha256": hash(path)?}),
    )
}
/// 校验计算输出路径、长度与内容摘要；任何一项不匹配拒绝发布。
pub fn verify(root: &Path, value: &Value) -> Result<PathBuf> {
    let _logging_step = crate::monitoring::Step::new("files::verify", serde_json::json!({}));
    if value.as_object().map(|x| x.len()) != Some(3) {
        return Err(Error::bad("资源引用字段无效"));
    }
    let path = within(
        root,
        value["path"]
            .as_str()
            .ok_or_else(|| Error::bad("缺少资源路径"))?,
    )?;
    if !path.is_file()
        || value["bytes"].as_u64() != Some(fs::metadata(&path)?.len())
        || value["sha256"].as_str() != Some(&hash(&path)?)
    {
        return Err(Error::bad("计算资源长度或摘要不匹配"));
    }
    Ok(path)
}
/// 同卷目录交换，发布失败时恢复旧目录；成功后清理仅本次产生的备份。
pub fn publish(source: &Path, target: &Path) -> Result<()> {
    let _logging_step = crate::monitoring::Step::new(
        "files::publish",
        serde_json::json!({"source":source,"target":target}),
    );
    publish_with(source, target, || Ok(()))
}
/// 发布目录或文件后执行关联事务；事务失败恢复旧资源，成功后的备份清理失败只记录日志。
pub fn publish_with<T>(
    source: &Path,
    target: &Path,
    finish: impl FnOnce() -> Result<T>,
) -> Result<T> {
    let _logging_step = crate::monitoring::Step::new(
        "files::publish_with",
        serde_json::json!({"source":source,"target":target}),
    );
    fs::create_dir_all(
        target
            .parent()
            .ok_or_else(|| Error::bad("缺少目标父目录"))?,
    )?;
    let backup = target.with_extension(format!("{}.old", identifier()));
    let existed = target.exists();
    if existed {
        fs::rename(target, &backup)?;
    }
    if let Err(error) = fs::rename(source, target) {
        let rollback = if existed {
            fs::rename(&backup, target)
        } else {
            Ok(())
        };
        record_rollback(target, &error.to_string(), &rollback);
        rollback.map_err(|failure| {
            Error::bad(format!("发布失败：{error}；恢复旧资源失败：{failure}"))
        })?;
        return Err(error.into());
    }
    match finish() {
        Ok(value) => {
            if existed {
                if let Err(error) = remove_resource(&backup) {
                    crate::logging::issue(
                        crate::runtime_logging::Level::Warn,
                        format_args!("发布成功，备份清理失败 {}：{error}", backup.display()),
                    );
                }
            }
            Ok(value)
        }
        Err(error) => {
            let rollback = remove_resource(target).and_then(|()| {
                if existed {
                    fs::rename(&backup, target)
                } else {
                    Ok(())
                }
            });
            record_rollback(target, &error.to_string(), &rollback);
            rollback
                .map_err(|failure| Error::bad(format!("事务失败：{error}；回滚失败：{failure}")))?;
            Err(error)
        }
    }
}
/// 只在失败后的恢复路径记录实际结果，保留最初原因与恢复错误。
fn record_rollback(target: &Path, reason: &str, result: &std::io::Result<()>) {
    if let Some(operation) = crate::monitoring::current() {
        operation.remember(serde_json::json!({"rollback_target":target,"original_error":reason,
            "rollback_succeeded":result.is_ok(),"rollback_error":result.as_ref().err().map(ToString::to_string)}));
    }
}
/// 清理调用方已经验证的本次事务资源，区分文件与目录。
fn remove_resource(path: &Path) -> std::io::Result<()> {
    let _logging_step =
        crate::monitoring::Step::new("files::remove_resource", serde_json::json!({"path":path}));
    if path.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}
