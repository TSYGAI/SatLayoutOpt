//! 文件说明：Rust 前置配置与持久化；逐段核对安装筒完整范围和基座的罩内容纳关系，B-Rep 委托独立计算。
use crate::{
    blocking,
    compute::{Engine, Task},
    config::Config,
    database,
    error::{Error, Result},
    files,
    model_settings::number,
    store::Store,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;

pub(crate) const FAIRING_FORMS: [&str; 4] = [
    "lower_cone_cylinder_upper_cone",
    "lower_cone_cylinder",
    "cylinder_upper_cone",
    "cylinder",
];

/// 返回区间内指定高度的线性截面半径；端点保留输入值，避免浮点消减误判贴合。
fn linear_radius_at(position: f64, bottom: f64, top: f64, lower: f64, upper: f64) -> f64 {
    if position == bottom {
        lower
    } else if position == top {
        upper
    } else {
        lower + (upper - lower) * ((position - bottom) / (top - bottom))
    }
}

/// 前置配置存储与几何任务串行锁；读写连接短生命周期，不持有 CAD 对象。
pub struct PreConfig {
    pub config: Arc<Config>,
    pub database: PathBuf,
    pub directory: PathBuf,
    pub lock: Mutex<()>,
    geometry_gate: tokio::sync::Mutex<()>,
    pub store: Arc<Store>,
    pub engine: Arc<Engine>,
    pub(crate) fixed_gate: tokio::sync::Mutex<()>,
    pub(crate) fixed_cache: Mutex<crate::fixed_preview_cache::FixedCache>,
}
impl PreConfig {
    /// 初始化版本 6 表；仅给旧对称表补 mode，已有配置保持原内容。
    pub fn open(config: Arc<Config>, store: Arc<Store>, engine: Arc<Engine>) -> Result<Self> {
        let _logging_step = crate::monitoring::Step::new("pre_config::open", serde_json::json!({}));
        let directory = config.directory("pre_config", "pre_config_dir");
        fs::create_dir_all(&directory)?;
        let database = directory.join(config.string("pre_config", "pre_config_database_name"));
        let connection = database::connect(&database, &config)?;
        connection.execute_batch("CREATE TABLE IF NOT EXISTS pre_config_values(config_key TEXT PRIMARY KEY,value_json TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE TABLE IF NOT EXISTS pre_config_satellite_counts(record_id TEXT PRIMARY KEY,satellite_count INTEGER NOT NULL,updated_at TEXT NOT NULL);CREATE TABLE IF NOT EXISTS pre_config_satellite_symmetry(record_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),mode TEXT NOT NULL DEFAULT 'hard' CHECK(mode IN('hard','soft')));")?;
        let mut statement =
            connection.prepare("PRAGMA table_info(pre_config_satellite_symmetry)")?;
        let columns = statement
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        if !columns.iter().any(|x| x == "mode") {
            connection.execute_batch("ALTER TABLE pre_config_satellite_symmetry ADD COLUMN mode TEXT NOT NULL DEFAULT 'hard' CHECK(mode IN('hard','soft'))")?;
        }
        connection.execute_batch("DELETE FROM pre_config_values WHERE config_key IN('custom_cylinder','satellite_count');PRAGMA user_version=6;")?;
        Ok(Self {
            config,
            database,
            directory,
            lock: Mutex::new(()),
            geometry_gate: tokio::sync::Mutex::new(()),
            store,
            engine,
            fixed_gate: tokio::sync::Mutex::new(()),
            fixed_cache: Mutex::new(Default::default()),
        })
    }
    /// 返回表单约束，名称沿用原接口。
    pub fn limits(&self) -> Value {
        let _logging_step =
            crate::monitoring::Step::new("pre_config::limits", serde_json::json!({}));
        let p = &self.config.values["pre_config"];
        json!({"min_satellite_count":p["min_satellite_count"],"max_satellite_count":p["max_satellite_count"],"min_fairing_radius_mm":p["min_cylinder_radius_mm"],"min_fairing_height_mm":p["min_cylinder_height_mm"],"max_fairing_size_mm":p["max_cylinder_size_mm"],"min_axis_radius_mm":p["min_axis_radius_mm"],"min_fairing_shell_radius_mm":p["min_fairing_shell_radius_mm"]})
    }
    /// 按安装筒最小半径取得兼容默认质心偏移，必要时缩小到半径的一半。
    fn default_axis(&self, radius: f64) -> f64 {
        let _logging_step =
            crate::monitoring::Step::new("pre_config::default_axis", serde_json::json!({}));
        let value = self
            .config
            .number("pre_config", "default_axis_radius_mm")
            .max(self.config.number("pre_config", "min_axis_radius_mm"));
        if value < radius {
            value
        } else {
            radius / 2.0
        }
    }
    /// 获取严格大于最大舱半径的默认整流罩，无法落在上限内时返回业务冲突。
    fn default_shell(&self, radius: f64) -> Result<f64> {
        let _logging_step =
            crate::monitoring::Step::new("pre_config::default_shell", serde_json::json!({}));
        let value = self
            .config
            .number("pre_config", "default_fairing_shell_radius_mm")
            .max(
                radius
                    + self
                        .config
                        .number("pre_config", "min_fairing_shell_radius_mm")
                        .max(1e-9),
            );
        if value > self.config.number("pre_config", "max_cylinder_size_mm") {
            return Err(Error::conflict("统一上限内无法设置更大的整流罩半径"));
        }
        Ok(value)
    }
    /// 校验安装筒区间、质心偏移与整流罩外形关系；格式由请求层验证，范围冲突返回 409。
    fn validate(&self, value: &Value) -> Result<()> {
        let _logging_step =
            crate::monitoring::Step::new("pre_config::validate", serde_json::json!({}));
        let max = self.config.number("pre_config", "max_cylinder_size_mm");
        for (key, min) in [
            ("min_radius_mm", "min_cylinder_radius_mm"),
            ("max_radius_mm", "min_cylinder_radius_mm"),
            ("min_height_mm", "min_cylinder_height_mm"),
            ("max_height_mm", "min_cylinder_height_mm"),
            ("axis_radius_mm", "min_axis_radius_mm"),
            ("fairing_radius_mm", "min_fairing_shell_radius_mm"),
        ] {
            number(&value[key], key, self.config.number("pre_config", min), max)
                .map_err(|e| Error::conflict(e.message))?;
        }
        if value["min_radius_mm"].as_f64() > value["max_radius_mm"].as_f64()
            || value["min_height_mm"].as_f64() > value["max_height_mm"].as_f64()
        {
            return Err(Error::conflict("半径和高度最小值不得大于最大值"));
        }
        if value["axis_radius_mm"].as_f64() >= value["min_radius_mm"].as_f64() {
            return Err(Error::conflict("质心最大偏移必须小于安装筒半径"));
        }
        if value["fairing_radius_mm"].as_f64() < value["max_radius_mm"].as_f64() {
            return Err(Error::conflict("整流罩半径不得小于安装筒半径最大值"));
        }
        self.validate_profile(
            &value["fairing_profile"],
            value["fairing_radius_mm"].as_f64().unwrap(),
        )?;
        Ok(())
    }
    /// 校验基座独立尺寸并派生上底面范围；未指定时直接加载集中配置的预设基座。
    fn normalized_base(&self, base: &Value, value: &Value) -> Result<Value> {
        let _logging_step =
            crate::monitoring::Step::new("pre_config::normalized_base", serde_json::json!({}));
        let bottom = &value["fairing_profile"]["segments"][0];
        let bottom_radius = if bottom["kind"] == "lower_cone" {
            bottom["lower_radius_mm"].as_f64()
        } else {
            bottom["radius_mm"].as_f64()
        }
        .unwrap_or(value["fairing_radius_mm"].as_f64().unwrap());
        let preset = json!({
            "lower_radius_mm":self.config.number("pre_config", "default_installation_base_lower_radius_mm")
                .min(bottom_radius),
            "height_mm":self.config.number("pre_config", "default_installation_base_height_mm")
        });
        let base = if base.is_null() { &preset } else { base };
        if !base.is_object() {
            return Err(Error::conflict("安装筒基座必须是参数对象"));
        }
        let maximum = self.config.number("pre_config", "max_cylinder_size_mm");
        let dimension = |key: &str, label: &str, minimum: &str| -> Result<f64> {
            number(
                &base[key],
                label,
                self.config.number("pre_config", minimum),
                maximum,
            )
            .map_err(|error| Error::conflict(error.message))
        };
        let lower = dimension(
            "lower_radius_mm",
            "基座下底面半径",
            "min_cylinder_radius_mm",
        )?;
        let height = dimension("height_mm", "基座高度", "min_cylinder_height_mm")?;
        if lower > value["fairing_radius_mm"].as_f64().unwrap() {
            return Err(Error::conflict("基座下底面半径不得超过整流罩最大半径"));
        }
        if height + value["max_height_mm"].as_f64().unwrap() > maximum {
            return Err(Error::conflict("安装筒与基座的整体高度超出统一尺寸上限"));
        }
        Ok(json!({"lower_radius_mm":lower,"height_mm":height,
            "min_upper_radius_mm":value["min_radius_mm"],"max_upper_radius_mm":value["max_radius_mm"]}))
    }
    /// 保存及优化前检查完整范围；截面分段线性，逐段比较组件重叠区间两端即可覆盖全高，贴合允许。
    pub(crate) fn validate_installation_bounds(&self, value: &Value) -> Result<()> {
        let _logging_step = crate::monitoring::Step::new(
            "pre_config::validate_installation_bounds",
            serde_json::json!({}),
        );
        self.validate(value)?;
        let base = self.normalized_base(&value["installation_tube"]["base"], value)?;
        let segments = value["fairing_profile"]["segments"].as_array().unwrap();
        let bottom = &segments[0];
        let bottom_radius = if bottom["kind"] == "lower_cone" {
            bottom["lower_radius_mm"].as_f64().unwrap()
        } else {
            bottom["radius_mm"].as_f64().unwrap()
        };
        if value["max_radius_mm"].as_f64().unwrap() > base["lower_radius_mm"].as_f64().unwrap() {
            return Err(Error::conflict("安装筒半径最大值不得超过基座下底面半径"));
        }
        if base["lower_radius_mm"].as_f64().unwrap() > bottom_radius {
            return Err(Error::conflict(if bottom["kind"] == "lower_cone" {
                "基座下底面半径不得超过下锥段下底面半径"
            } else {
                "基座下底面半径不得超过整流罩圆柱段半径"
            }));
        }
        let height: f64 = segments
            .iter()
            .map(|item| item["height_mm"].as_f64().unwrap())
            .sum();
        if value["max_height_mm"].as_f64().unwrap() + base["height_mm"].as_f64().unwrap() > height {
            return Err(Error::conflict(
                "基座高度与安装筒高度最大值之和不得超过整流罩总高度",
            ));
        }
        let radius = value["max_radius_mm"].as_f64().unwrap();
        let base_height = base["height_mm"].as_f64().unwrap();
        let components = [
            (
                "基座",
                0.0,
                base_height,
                base["lower_radius_mm"].as_f64().unwrap(),
                radius,
            ),
            (
                "安装筒",
                base_height,
                base_height + value["max_height_mm"].as_f64().unwrap(),
                radius,
                radius,
            ),
        ];
        let mut start: f64 = 0.0;
        for segment in segments {
            let segment_height = segment["height_mm"].as_f64().unwrap();
            let end = start + segment_height;
            let (label, lower, upper) = match segment["kind"].as_str().unwrap() {
                "cylinder" => (
                    "圆柱段",
                    segment["radius_mm"].as_f64().unwrap(),
                    segment["radius_mm"].as_f64().unwrap(),
                ),
                kind => (
                    if kind == "lower_cone" {
                        "下锥段"
                    } else {
                        "上锥段"
                    },
                    segment["lower_radius_mm"].as_f64().unwrap(),
                    segment["upper_radius_mm"].as_f64().unwrap(),
                ),
            };
            for (component, bottom, top, component_lower, component_upper) in components {
                let overlap_bottom = start.max(bottom);
                let overlap_top = end.min(top);
                if overlap_bottom > overlap_top {
                    continue;
                }
                for position in [overlap_bottom, overlap_top] {
                    let available = linear_radius_at(position, start, end, lower, upper);
                    let required =
                        linear_radius_at(position, bottom, top, component_lower, component_upper);
                    if required > available {
                        return Err(Error::conflict(format!(
                            "整流罩{label}在距罩底 {position} 毫米处的可用半径为 {available} 毫米，小于{component}所需的 {required} 毫米，无法容纳{component}。请增大整流罩对应位置的半径或调整{component}尺寸。"
                        )));
                    }
                }
            }
            start = end;
        }
        Ok(())
    }
    /// 只校验规范化后的段序列；旧记录和请求字段已在进入此方法前统一转换。
    fn validate_profile(&self, profile: &Value, shell_radius: f64) -> Result<()> {
        let _logging_step =
            crate::monitoring::Step::new("pre_config::validate_profile", serde_json::json!({}));
        if !profile.is_object() {
            return Err(Error::conflict("整流罩组合段记录格式无效"));
        }
        let form = match profile.get("form") {
            Some(value) => value
                .as_str()
                .ok_or_else(|| Error::conflict("整流罩形态必须为字符串"))?,
            None => "cylinder",
        };
        if !FAIRING_FORMS.contains(&form) {
            return Err(Error::conflict("不支持的整流罩形态"));
        }
        let segments = profile["segments"]
            .as_array()
            .ok_or_else(|| Error::conflict("整流罩组合段必须为数组"))?;
        let expected_kinds: &[&str] = match form {
            "lower_cone_cylinder_upper_cone" => &["lower_cone", "cylinder", "upper_cone"],
            "lower_cone_cylinder" => &["lower_cone", "cylinder"],
            "cylinder_upper_cone" => &["cylinder", "upper_cone"],
            _ => &["cylinder"],
        };
        if segments.len() != expected_kinds.len() {
            return Err(Error::conflict("整流罩组合段数量与形态不一致"));
        }
        let positive = |segment: &Value, key: &str, label: &str| -> Result<f64> {
            segment
                .get(key)
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite() && *value > 0.0)
                .ok_or_else(|| Error::conflict(format!("{label}必须为正数")))
        };
        let mut maximum: f64 = 0.0;
        let mut previous_upper: Option<f64> = None;
        for (index, segment) in segments.iter().enumerate() {
            if !segment.is_object() {
                return Err(Error::conflict("整流罩组合段记录格式无效"));
            }
            let kind = segment
                .get("kind")
                .and_then(Value::as_str)
                .ok_or_else(|| Error::conflict("整流罩段类型不能为空"))?;
            if kind != expected_kinds[index] {
                return Err(Error::conflict("整流罩组合段顺序与形态不一致"));
            }
            positive(segment, "height_mm", "整流罩段高度")?;
            let (lower, upper) = if kind == "cylinder" {
                let radius = positive(segment, "radius_mm", "圆柱段半径")?;
                (radius, radius)
            } else {
                (
                    positive(segment, "lower_radius_mm", "整流罩段下底面半径")?,
                    positive(segment, "upper_radius_mm", "整流罩段上底面半径")?,
                )
            };
            if let Some(previous) = previous_upper {
                if (previous - lower).abs() > 1e-9 {
                    return Err(Error::conflict("相邻整流罩段半径必须连续"));
                }
            }
            previous_upper = Some(upper);
            maximum = maximum.max(lower).max(upper);
        }
        if shell_radius < maximum {
            return Err(Error::conflict("整流罩边界不能小于组合外形的最大半径"));
        }
        Ok(())
    }
    /// 将平铺锥段和旧圆柱记录统一为段列表；格式与业务校验交由 validate_profile。
    fn normalized_profile(profile: &Value, cylinder_radius: f64, cylinder_height: f64) -> Value {
        let _logging_step =
            crate::monitoring::Step::new("pre_config::normalized_profile", serde_json::json!({}));
        if profile["segments"]
            .as_array()
            .is_some_and(|items| !items.is_empty())
        {
            return profile.clone();
        }
        let cylinder_radius = profile["cylinder"]["radius_mm"]
            .as_f64()
            .unwrap_or(cylinder_radius);
        let cylinder_height = profile["cylinder"]["height_mm"]
            .as_f64()
            .unwrap_or(cylinder_height);
        let form = profile["form"].as_str().unwrap_or("cylinder");
        let mut segments = Vec::new();
        if matches!(
            form,
            "lower_cone_cylinder" | "lower_cone_cylinder_upper_cone"
        ) {
            let lower = &profile["lower_cone"];
            segments.push(json!({
                "kind":"lower_cone",
                "lower_radius_mm":lower["lower_radius_mm"],
                "upper_radius_mm":lower["upper_radius_mm"].as_f64().unwrap_or(cylinder_radius),
                "height_mm":lower["height_mm"]
            }));
        }
        segments.push(
            json!({"kind":"cylinder","radius_mm":cylinder_radius,"height_mm":cylinder_height}),
        );
        if matches!(
            form,
            "cylinder_upper_cone" | "lower_cone_cylinder_upper_cone"
        ) {
            let upper = &profile["upper_cone"];
            segments.push(json!({
                "kind":"upper_cone",
                "lower_radius_mm":upper["lower_radius_mm"].as_f64().unwrap_or(cylinder_radius),
                "upper_radius_mm":upper["upper_radius_mm"],
                "height_mm":upper["height_mm"]
            }));
        }
        let total_height: f64 = segments
            .iter()
            .map(|item| item["height_mm"].as_f64().unwrap_or(0.0))
            .sum();
        let max_radius = segments
            .iter()
            .flat_map(|item| {
                [
                    item["radius_mm"].as_f64(),
                    item["lower_radius_mm"].as_f64(),
                    item["upper_radius_mm"].as_f64(),
                ]
            })
            .flatten()
            .fold(0.0, f64::max);
        json!({"form":form,"segments":segments,"total_height_mm":total_height,"max_radius_mm":max_radius})
    }
    /// 读取已保存尺寸或默认值；历史单值扩展为区间，旧净距换算为整流罩半径。
    pub fn fairing(&self) -> Result<Value> {
        let _logging_step =
            crate::monitoring::Step::new("pre_config::fairing", serde_json::json!({}));
        let connection = database::connect(&self.database, &self.config)?;
        let row:Option<(String,String)>=connection.query_row("SELECT value_json,updated_at FROM pre_config_values WHERE config_key='custom_fairing_segment'",[],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        let (mut value, updated, stored) = if let Some((encoded, time)) = row {
            (serde_json::from_str::<Value>(&encoded)?, Some(time), true)
        } else {
            let radius = self
                .config
                .number("pre_config", "default_cylinder_radius_mm");
            let height = self
                .config
                .number("pre_config", "default_cylinder_height_mm");
            (
                json!({"min_radius_mm":radius,"max_radius_mm":radius,"min_height_mm":height,"max_height_mm":height,
                    "fairing_profile":{"form":"cylinder","cylinder":{"radius_mm":self.default_shell(radius)?,
                        "height_mm":height+self.config.number("pre_config","default_installation_base_height_mm")}}}),
                None,
                false,
            )
        };
        for (key, legacy) in [
            ("min_radius_mm", "radius_mm"),
            ("max_radius_mm", "radius_mm"),
            ("min_height_mm", "height_mm"),
            ("max_height_mm", "height_mm"),
        ] {
            if value[key].is_null() {
                value[key] = value[legacy].clone();
            }
        }
        let min = value["min_radius_mm"]
            .as_f64()
            .ok_or_else(|| Error::conflict("已保存的整流舱参数损坏"))?;
        let max = value["max_radius_mm"]
            .as_f64()
            .ok_or_else(|| Error::conflict("已保存的整流舱参数损坏"))?;
        if value["installation_tube"].is_null() {
            value["installation_tube"] = json!({
                "min_radius_mm": value["min_radius_mm"],
                "max_radius_mm": value["max_radius_mm"],
                "min_height_mm": value["min_height_mm"],
                "max_height_mm": value["max_height_mm"],
                "centroid_max_offset_mm": value["centroid_max_offset_mm"].as_f64().or(value["axis_radius_mm"].as_f64()).unwrap_or(self.default_axis(min))
            });
        }
        if value["axis_radius_mm"].is_null() {
            value["axis_radius_mm"] = value["installation_tube"]["centroid_max_offset_mm"].clone();
        }
        if value["centroid_max_offset_mm"].is_null() {
            value["centroid_max_offset_mm"] = value["axis_radius_mm"].clone();
        }
        if value["fairing_radius_mm"].is_null() {
            let legacy = value["radial_clearance_mm"]
                .as_f64()
                .map(|c| c + min)
                .filter(|c| *c > max);
            value["fairing_radius_mm"] = json!(match legacy {
                Some(x) => x,
                None => self.default_shell(max)?,
            });
        }
        value["fairing_profile"] = Self::normalized_profile(
            &value["fairing_profile"],
            min,
            value["min_height_mm"].as_f64().unwrap(),
        );
        self.validate(&value)?;
        let base = self.normalized_base(&value["installation_tube"]["base"], &value)?;
        value["installation_tube"]["base"] = base;
        let p = &self.config.values["pre_config"];
        let cylinder = value["fairing_profile"]["segments"]
            .as_array()
            .and_then(|items| items.iter().find(|item| item["kind"] == "cylinder"))
            .cloned()
            .unwrap_or_else(|| json!({}));
        Ok(
            json!({"min_radius_mm":value["min_radius_mm"],"max_radius_mm":value["max_radius_mm"],"min_height_mm":value["min_height_mm"],"max_height_mm":value["max_height_mm"],"axis_radius_mm":value["axis_radius_mm"],"centroid_max_offset_mm":value["centroid_max_offset_mm"],"installation_tube":value["installation_tube"],"fairing_radius_mm":value["fairing_radius_mm"],"fairing_form":value["fairing_profile"]["form"],"fairing_cylinder_radius_mm":cylinder["radius_mm"],"fairing_cylinder_height_mm":cylinder["height_mm"],"fairing_profile":value["fairing_profile"],"radial_segments":value.get("radial_segments").filter(|v|v.as_i64().unwrap_or(0)!=0).unwrap_or(&p["cylinder_radial_segments"]),"updated_at":updated,"stored":stored}),
        )
    }
    /// 把固化记录与已保存数量、对称模式合并，未保存类型默认零颗。
    pub fn satellites(&self, records: &[Value]) -> Result<Vec<Value>> {
        let _logging_step =
            crate::monitoring::Step::new("pre_config::satellites", serde_json::json!({}));
        let connection = database::connect(&self.database, &self.config)?;
        let mut result = vec![];
        for record in records {
            let id = record["record_id"].as_str().unwrap();
            let count:Option<(i64,String)>=connection.query_row("SELECT satellite_count,updated_at FROM pre_config_satellite_counts WHERE record_id=?",[id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            let symmetry: Option<(bool, String)> = connection
                .query_row(
                    "SELECT enabled,mode FROM pre_config_satellite_symmetry WHERE record_id=?",
                    [id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            result.push(json!({"record_id":id,"device_name":record["device_name"],"created_at":record["created_at"],"count":count.as_ref().map(|x|x.0).unwrap_or(0),"updated_at":count.as_ref().map(|x|&x.1),"stored":count.is_some(),"symmetry_enabled":symmetry.as_ref().map(|x|x.0).unwrap_or(false),"symmetry_mode":symmetry.as_ref().map(|x|x.1.as_str()).unwrap_or("hard")}));
        }
        Ok(result)
    }
    /// 获取页面配置并清理已删除固化记录的数量及对称条目。
    pub fn get(&self) -> Result<Value> {
        let _logging_step = crate::monitoring::Step::new("pre_config::get", serde_json::json!({}));
        let _store = self.store.lock.lock().unwrap();
        let _guard = self.lock.lock().unwrap();
        let records = self.store.all()?;
        let satellites = self.satellites(&records)?;
        let mut connection = database::connect(&self.database, &self.config)?;
        let tx = connection.transaction()?;
        for table in [
            "pre_config_satellite_counts",
            "pre_config_satellite_symmetry",
        ] {
            let mut statement = tx.prepare(&format!("SELECT record_id FROM {table}"))?;
            let ids = statement
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            drop(statement);
            for id in ids {
                if !records.iter().any(|r| r["record_id"] == id) {
                    tx.execute(&format!("DELETE FROM {table} WHERE record_id=?"), [id])?;
                }
            }
        }
        tx.commit()?;
        Ok(
            json!({"satellites":satellites,"fairing_segment":self.fairing()?,"limits":self.limits()}),
        )
    }
    /// 保存某类型数量；沿用旧接口保存后检查类型是否存在的语义。
    pub fn save_count(&self, id: &str, count: i64) -> Result<Value> {
        let _logging_step =
            crate::monitoring::Step::new("pre_config::save_count", serde_json::json!({"id":id}));
        let _store = self.store.lock.lock().unwrap();
        let _guard = self.lock.lock().unwrap();
        if count < self.config.integer("pre_config", "min_satellite_count") as i64
            || count > self.config.integer("pre_config", "max_satellite_count") as i64
        {
            return Err(Error::conflict("卫星数量超出允许范围"));
        }
        database::connect(&self.database,&self.config)?.execute("INSERT INTO pre_config_satellite_counts VALUES(?1,?2,?3) ON CONFLICT(record_id) DO UPDATE SET satellite_count=excluded.satellite_count,updated_at=excluded.updated_at",params![id,count,files::now()])?;
        let record = self.store.get(id)?;
        let satellite = self.satellites(&[record])?.remove(0);
        Ok(json!({"satellite":satellite,"limits":self.limits()}))
    }
    /// 为存在的类型保存严格布尔开关及软硬模式。
    pub fn save_symmetry(&self, id: &str, enabled: bool, mode: &str) -> Result<Value> {
        let _logging_step =
            crate::monitoring::Step::new("pre_config::save_symmetry", serde_json::json!({"id":id}));
        let _store = self.store.lock.lock().unwrap();
        let _guard = self.lock.lock().unwrap();
        let record = self.store.get(id)?;
        database::connect(&self.database,&self.config)?.execute("INSERT INTO pre_config_satellite_symmetry VALUES(?1,?2,?3) ON CONFLICT(record_id) DO UPDATE SET enabled=excluded.enabled,mode=excluded.mode",params![id,enabled,mode])?;
        Ok(json!({"satellite":self.satellites(&[record])?.remove(0)}))
    }
    /// 串行构建几何后保存参数；生成失败不修改已保存配置或正式 STEP。
    pub async fn save_fairing(self: &Arc<Self>, mut value: Value) -> Result<Value> {
        let _logging_step =
            crate::monitoring::Step::new("pre_config::save_fairing", serde_json::json!({}));
        let _gate = self.geometry_gate.lock().await;
        let this = self.clone();
        let (value,task)=blocking(move ||{
            let _guard=this.lock.lock().unwrap();let current=this.fairing()?;
            let min=value["min_radius_mm"].as_f64().ok_or_else(||Error::invalid("缺少底面半径"))?;
            if value["axis_radius_mm"].is_null(){let inherited=current["axis_radius_mm"].as_f64().unwrap();value["axis_radius_mm"]=json!(if inherited<min{inherited}else{this.default_axis(min)});}
            value["fairing_profile"] = Self::normalized_profile(&value["fairing_profile"], min, value["min_height_mm"].as_f64().unwrap());
            if !value["installation_tube"].is_null() {
                value["fairing_radius_mm"] = value["fairing_profile"]["max_radius_mm"].clone();
            }
            value["centroid_max_offset_mm"] = value["axis_radius_mm"].clone();
            let base = this.normalized_base(&value["installation_tube"]["base"], &value)?;
            value["installation_tube"] = json!({
                "min_radius_mm": value["min_radius_mm"], "max_radius_mm": value["max_radius_mm"],
                "min_height_mm": value["min_height_mm"], "max_height_mm": value["max_height_mm"],
                "centroid_max_offset_mm": value["axis_radius_mm"]
            });
            value["installation_tube"]["base"] = json!({
                "lower_radius_mm":base["lower_radius_mm"],"height_mm":base["height_mm"]
            });
            this.validate_installation_bounds(&value)?;value["radial_segments"]=this.config.values["pre_config"]["cylinder_radial_segments"].clone();
            let task=Task::new(&this.config,"fairing.generate",&json!({"radius_mm":value["min_radius_mm"],"height_mm":value["min_height_mm"],"axis_radius_mm":value["axis_radius_mm"],"centroid_max_offset_mm":value["centroid_max_offset_mm"],"profile":value["fairing_profile"]}))?;Ok((value,task))
        }).await?;
        let outcome = self
            .engine
            .run(task, "fairing", CancellationToken::new(), None)
            .await?;
        if outcome.cancelled {
            return Err(Error::conflict("整流舱段生成已取消"));
        }
        let this = self.clone();
        blocking(move ||{
            let _guard=this.lock.lock().unwrap();let root=this.directory.join(this.config.string("pre_config","pre_config_cylinder_subdir"));fs::create_dir_all(&root)?;
            let mut connection=database::connect(&this.database,&this.config)?;let tx=connection.transaction()?;
            tx.execute("INSERT INTO pre_config_values VALUES('custom_fairing_segment',?1,?2) ON CONFLICT(config_key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",params![value.to_string(),files::now()])?;
            files::publish_with(&outcome.task.output.join("artifacts/fairing-segment.step"),&root.join("fairing-segment.step"),||{tx.commit()?;Ok(())})?;
            let mut geometry=outcome.result["geometry"].clone();
            geometry["preview_source"]=json!("interval_minimum");
            geometry["fairing_radius_mm"]=value["fairing_radius_mm"].clone();
            geometry["installation_tube"]=value["installation_tube"].clone();
            let base = this.normalized_base(&value["installation_tube"]["base"], &value)?;
            geometry["installation_tube"]["base"] = base;
            geometry["centroid_max_offset_mm"]=value["centroid_max_offset_mm"].clone();
            geometry["fairing_cylinder_radius_mm"]=value["fairing_cylinder_radius_mm"].clone();
            geometry["fairing_cylinder_height_mm"]=value["fairing_cylinder_height_mm"].clone();
            geometry["fairing_profile"]=value["fairing_profile"].clone();
            Ok(json!({"fairing_segment":this.fairing()?,"geometry":geometry}))
        }).await
    }
}
