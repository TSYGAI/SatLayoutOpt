//! 文件说明：按编辑会话管理实时校验的递增版本与协作取消；只保留最新状态，隔离不同来源和浏览器，不保存几何结果。
use crate::error::{Error, Result};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

/// 保留会话版本高水位，拒绝乱序旧请求；空闲记录按集中配置过期并限制容量。
pub struct Validations {
    sessions: Mutex<HashMap<String, Session>>,
    idle: Duration,
    capacity: usize,
}

/// 一个来源编辑会话的最新请求；关闭后保留墓碑，阻止在途旧请求重新启动。
struct Session {
    revision: u64,
    cancel: CancellationToken,
    active: bool,
    closed: bool,
    touched: Instant,
}

/// 请求生命周期守卫；调用方退出时取消计算，迟到守卫不会修改更新版本。
pub struct Validation {
    registry: Arc<Validations>,
    key: String,
    revision: u64,
    pub cancel: CancellationToken,
}

impl Validations {
    /// 创建有界会话登记；容量和空闲秒数必须由已校验的集中配置提供。
    pub fn new(idle: Duration, capacity: usize) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            idle,
            capacity,
        }
    }

    /// 校验会话 UUID 并关联任务与来源，防止跨项目或跨浏览器取消。
    fn key(job: &str, source: &str, session: &str) -> Result<String> {
        let session = uuid::Uuid::parse_str(session)
            .map_err(|_| Error::invalid("实时校验会话必须为 UUID"))?;
        Ok(format!("{job}/{source}/{session}"))
    }

    /// 清理空闲记录并核对容量；正在运行的校验不因过期被移除。
    fn reserve(&self, sessions: &mut HashMap<String, Session>, key: &str) -> Result<()> {
        sessions.retain(|_, entry| entry.active || entry.touched.elapsed() < self.idle);
        if !sessions.contains_key(key) && sessions.len() >= self.capacity {
            return Err(Error::conflict("实时校验会话数量已达上限，请稍后重试"));
        }
        Ok(())
    }

    /// 登记严格递增的新版本并立即取消旧版本；重排网络请求不能覆盖最新状态。
    pub fn begin(
        self: &Arc<Self>,
        job: &str,
        source: &str,
        session: &str,
        revision: u64,
    ) -> Result<Validation> {
        if revision == 0 {
            return Err(Error::invalid("实时校验版本必须为正整数"));
        }
        let key = Self::key(job, source, session)?;
        let mut sessions = self.sessions.lock().unwrap();
        self.reserve(&mut sessions, &key)?;
        if let Some(previous) = sessions.get(&key) {
            if previous.closed || revision <= previous.revision {
                return Err(Error::conflict("实时校验已被更新操作替代"));
            }
            previous.cancel.cancel();
        }
        let cancel = CancellationToken::new();
        sessions.insert(
            key.clone(),
            Session {
                revision,
                cancel: cancel.clone(),
                active: true,
                closed: false,
                touched: Instant::now(),
            },
        );
        Ok(Validation {
            registry: self.clone(),
            key,
            revision,
            cancel,
        })
    }

    /// 重置或离页时关闭会话并取消其计算；即使关闭先于旧请求到达，也不会恢复旧计算。
    pub fn close(&self, job: &str, source: &str, session: &str) -> Result<()> {
        let key = Self::key(job, source, session)?;
        let mut sessions = self.sessions.lock().unwrap();
        self.reserve(&mut sessions, &key)?;
        let entry = sessions.entry(key).or_insert_with(|| Session {
            revision: 0,
            cancel: CancellationToken::new(),
            active: false,
            closed: true,
            touched: Instant::now(),
        });
        entry.closed = true;
        entry.touched = Instant::now();
        entry.cancel.cancel();
        Ok(())
    }
}

impl Drop for Validation {
    /// 无论成功、失败或 HTTP 调用方退出，都释放本次身份并取消尚未退出的计算。
    fn drop(&mut self) {
        self.cancel.cancel();
        let mut sessions = self.registry.sessions.lock().unwrap();
        if let Some(entry) = sessions.get_mut(&self.key) {
            if entry.revision == self.revision {
                entry.active = false;
                entry.touched = Instant::now();
            }
        }
    }
}
