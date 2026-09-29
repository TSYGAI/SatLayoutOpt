"""文件说明：管理布局后台任务、历史重命名与删除，持久化输入和几何快照，并提供安装表导出。

任务使用单工作线程，读取模型库后独立运行；重启时显式标记中断，可用同一输入重试，不冒充继续计算。
"""

from copy import deepcopy
from contextlib import closing
from datetime import datetime, timezone
import json
import hashlib
from pathlib import Path
import shutil
import sqlite3
from threading import Event, RLock, Thread
from uuid import uuid4

import numpy as np

from app.core.config import runtime_config
from app.domain.layout_config import LAYOUT_CONFIG
from app.domain.layout_export import export_candidate_workbook
from app.domain.layout_models import load_satellites
from app.domain.layout_solver import LayoutInfeasibleError, LayoutSearchCancelled, optimize_layout
from app.domain.model_store import ModelStore
from app.domain.pre_config_store import PreConfigStore
from app.schemas.layout_optimization import LayoutOptimizationPayload, ResolvedLayoutParameters


def utc_now() -> str:
    """返回带时区的 UTC 时间，供历史记录与前端展示使用。"""
    return datetime.now(timezone.utc).isoformat()


class LayoutJobService:
    """提供布局任务创建、取消、历史和快照查询；每进程只允许一项任务使用计算资源。"""

    def __init__(self, storage_dir=None, model_store=None, pre_config=None):
        """创建布局专用存储；可注入测试目录和模型库，历史运行态在启动时标为 interrupted。"""
        root = Path(__file__).resolve().parents[3]
        self.storage_dir = Path(storage_dir or root / LAYOUT_CONFIG["storage_dir"])
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        self.database_path = self.storage_dir / "jobs.sqlite3"
        self.models = model_store if model_store is not None else ModelStore()
        self.pre_config = pre_config if pre_config is not None else PreConfigStore()
        self._lock = RLock()
        self._thread = None
        self._active = None
        self._cancel = Event()
        with closing(sqlite3.connect(self.database_path)) as connection, connection:
            connection.execute("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL)")
            for identifier, encoded in connection.execute("SELECT id, payload FROM jobs").fetchall():
                job = json.loads(encoded)
                if job["status"] in {"queued", "running", "cancelling"}:
                    job.update(status="interrupted", finished_at=utc_now(), error="服务重新启动，之前的计算已中断；可按原参数重新运行")
                    connection.execute("UPDATE jobs SET payload=? WHERE id=?", (json.dumps(job, ensure_ascii=False), identifier))

    def config(self) -> dict:
        """返回锁定几何、含向上轴的模型清单、指纹及布局页可填写默认值，不覆盖前置配置或模型设置。"""
        records = []
        offset = 0
        while True:
            page = self.models.list_records(limit=500, offset=offset)
            records.extend(page["records"])
            offset += len(page["records"])
            if offset >= page["total"] or not page["records"]:
                break
        counts = {item["record_id"]: item["count"] for item in self.pre_config.list_satellite_counts([r["record_id"] for r in records])}
        result = {
            "geometry": self.pre_config.get_fairing_segment(),
            "candidate_count": LAYOUT_CONFIG["candidate_count"],
            "history_name_max_length": LAYOUT_CONFIG["history_name_max_length"],
            "defaults": {key: LAYOUT_CONFIG[key] for key in ("min_suspension_mm", "max_suspension_mm", "radius_step_mm")},
            "satellites": [{"record_id": r["record_id"], "name": r["device_name"], "count": counts[r["record_id"]],
                            "mass_kg": r["settings"].get("mass"), "center_of_mass": r["settings"].get("center_of_mass"),
                            "model_unit": r["settings"]["model_unit"],
                            "up_orientation": r["settings"].get("front_orientation", runtime_config.model_settings_default_front_orientation),
                            "installation_face_id": r["settings"].get("installation_face_id"),
                            "installation_point": r["settings"].get("installation_point")} for r in records],
        }
        locked = {"geometry": result["geometry"], "satellites": result["satellites"],
                  "model_fingerprints": [{"record_id": record["record_id"], "settings": record["settings"],
                                           "source": record["source"]["sha256"], "envelope": record["envelope"]["mesh_sha256"]}
                                          for record in records]}
        result["config_fingerprint"] = hashlib.sha256(json.dumps(locked, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
        return result

    def _save(self, job):
        """原子写入任务快照；调用方持有服务锁，SQLite 连接在返回前关闭。"""
        with closing(sqlite3.connect(self.database_path)) as connection, connection:
            connection.execute("INSERT OR REPLACE INTO jobs VALUES (?, ?, ?)",
                               (job["job_id"], job["created_at"], json.dumps(job, ensure_ascii=False, allow_nan=False)))

    def get(self, identifier):
        """返回指定任务的独立字典副本；未知标识抛 LookupError。"""
        with self._lock, closing(sqlite3.connect(self.database_path)) as connection:
            row = connection.execute("SELECT payload FROM jobs WHERE id=?", (identifier,)).fetchone()
        if row is None:
            raise LookupError("找不到指定布局任务")
        job = json.loads(row[0])
        job.setdefault("name", "")
        return job

    def history(self, limit=50, offset=0):
        """分页返回名称、运行状态、结果数量和原备注；旧记录未命名时返回空名称。"""
        with self._lock, closing(sqlite3.connect(self.database_path)) as connection:
            rows = connection.execute("SELECT payload FROM jobs ORDER BY created_at DESC LIMIT ? OFFSET ?", (limit, offset)).fetchall()
            total = connection.execute("SELECT COUNT(*) FROM jobs").fetchone()[0]
        jobs = [json.loads(row[0]) for row in rows]
        return {"jobs": [{key: job[key] for key in ("job_id", "created_at", "status", "notes", "error")}
                         | {"name": job.get("name", ""), "candidate_count": len(job["candidates"])} for job in jobs], "total": total}

    def rename(self, identifier, name):
        """持锁更新经过契约验证的展示名称并返回任务；不改变参数、备注、排序或运行状态。"""
        with self._lock:
            job = self.get(identifier)
            job["name"] = name
            self._save(job)
            return job

    def delete(self, identifier):
        """删除终态任务及其独立快照；未知任务抛 LookupError，活动态或快照清理失败抛 ValueError。"""
        with self._lock:
            job = self.get(identifier)
            if identifier == self._active or job["status"] in {"queued", "running", "cancelling"}:
                raise ValueError("任务仍在运行或收尾，请取消并等待结束后再删除")
            root = self.storage_dir.resolve()
            directory = (root / identifier).resolve()
            if directory.parent != root or directory == root or directory != root / identifier:
                raise ValueError("任务快照目录无效，无法删除")
            try:
                if directory.exists():
                    shutil.rmtree(directory)
            except OSError as error:
                raise ValueError("项目快照清理失败，历史记录已保留，请释放文件占用后重试") from error
            with closing(sqlite3.connect(self.database_path)) as connection, connection:
                connection.execute("DELETE FROM jobs WHERE id=?", (identifier,))

    def start(self, options: LayoutOptimizationPayload):
        """读取锁定前置/模型参数并核对页面指纹，保存快照后立即启动；拒绝页面中过期配置。"""
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                raise ValueError("已有布局任务运行中，请先取消或等待完成")
            configuration = self.config()
            if options.config_fingerprint != configuration["config_fingerprint"]:
                raise ValueError("前置配置或模型库已改变，请刷新锁定参数后重新开始")
            geometry = configuration["geometry"]
            if not geometry.get("stored"):
                raise ValueError("请先在前置配置页保存尺寸和卫星数量")
            parameters = ResolvedLayoutParameters(
                **{key: geometry[key] for key in ("min_radius_mm", "max_radius_mm", "min_height_mm", "max_height_mm", "axis_radius_mm", "fairing_radius_mm")},
                satellites=[{"record_id": item["record_id"], "count": item["count"]} for item in configuration["satellites"]],
                **options.model_dump(exclude={"config_fingerprint"}),
            )
            self._cancel = Event()
            identifier = uuid4().hex
            job = {"job_id": identifier, "name": "", "status": "queued", "created_at": utc_now(), "finished_at": None,
                   "parameters": parameters.model_dump(mode="json"), "notes": parameters.notes,
                   "options": options.model_dump(mode="json"), "locked_config": configuration,
                   "progress": {}, "events": [], "candidates": [], "error": ""}
            self._save(job)
            self._active = identifier
            self._thread = Thread(target=self._run, args=(identifier, parameters, self._cancel), daemon=True,
                                  name=f"layout-{identifier}")
            self._thread.start()
            return deepcopy(job)

    def _run(self, identifier, parameters, cancellation):
        """加载并快照正式几何，再持续优化；取消时保存并发布此前已经验收的候选。"""
        try:
            self._change(identifier, status="running")
            self._progress(identifier, {"message": "正在校验锁定模型、正式包络与指定安装面", "attempts": 0, "valid_count": 0})
            satellites = load_satellites(self.models, parameters.satellites, cancellation.is_set)
            if self.config()["config_fingerprint"] != self.get(identifier)["options"]["config_fingerprint"]:
                raise ValueError("加载期间前置配置或模型库已改变，请刷新锁定参数后重新开始")
            directory = self.storage_dir / identifier
            directory.mkdir()
            for model in {item.record_id: item for item in satellites}.values():
                inverse = np.linalg.inv(model.source_to_envelope)
                local_vertices = model.vertices @ inverse[:3, :3].T + inverse[:3, 3]
                snapshot = {"vertices": local_vertices, "faces": model.faces}
                if model.body_vertices is not None:
                    snapshot["body_vertices"] = model.body_vertices
                np.savez_compressed(directory / f"{model.record_id}.npz", **snapshot)
            candidates = optimize_layout(satellites, parameters, lambda progress: self._progress(identifier, progress), cancellation.is_set)
            with self._lock:
                if cancellation.is_set():
                    raise LayoutSearchCancelled(candidates)
                self._change(identifier, status="completed", candidates=candidates, finished_at=utc_now())
        except LayoutSearchCancelled as error:
            self._finish_cancelled(identifier, error.candidates)
        except InterruptedError:
            self._finish_cancelled(identifier, [])
        except LayoutInfeasibleError as error:
            self._change(identifier, status="infeasible", finished_at=utc_now(), error=str(error))
        except Exception as error:
            self._change(identifier, status="failed", finished_at=utc_now(), error=f"{type(error).__name__}: {error}")
        finally:
            with self._lock:
                self._active = None

    def _change(self, identifier, **changes):
        """在服务锁内合并并持久化任务字段，避免取消与完成相互覆盖。"""
        with self._lock:
            job = self.get(identifier)
            job.update(changes)
            self._save(job)

    def _progress(self, identifier, progress):
        """持久化最新进度及有限长度记录；没有搜索时间限制，记录条数仅限制存储体积。"""
        with self._lock:
            job = self.get(identifier)
            job["progress"] = progress
            job["events"] = [*job["events"], {"time": utc_now(), **progress}][-LAYOUT_CONFIG["progress_history_size"]:]
            self._save(job)

    def _finish_cancelled(self, identifier, candidates):
        """原子保存取消终态及已验收候选；尚无候选时仍保留明确的取消进度。"""
        with self._lock:
            job = self.get(identifier)
            count = len(candidates)
            message = (f"任务已取消，保留并展示取消前已验收的 {count} 组布局"
                       if count else "任务已取消，取消前尚未产出有效布局")
            progress = {**job.get("progress", {}), "valid_count": count, "returned_count": count,
                        "termination_reason": "cancelled", "message": message}
            job.update(status="cancelled", candidates=candidates, finished_at=utc_now(),
                       error="用户取消了优化", progress=progress)
            job["events"] = [*job.get("events", []), {"time": utc_now(), **progress}][
                -LAYOUT_CONFIG["progress_history_size"]:]
            self._save(job)

    def cancel(self, identifier):
        """请求协作取消，仅活动任务进入 cancelling；终态任务原样返回。"""
        with self._lock:
            job = self.get(identifier)
            if identifier == self._active and job["status"] in {"queued", "running", "cancelling"}:
                self._cancel.set()
                self._change(identifier, status="cancelling")
            return self.get(identifier)

    def meshes(self, identifier):
        """返回该任务保存的模型自身坐标包络；按 model_to_global_matrix 映射至毫米全局坐标，无结果时拒绝预览。"""
        with self._lock:
            job = self.get(identifier)
            if not job["candidates"]:
                raise LookupError("任务尚无有效布局")
            meshes = {}
            for item in job["parameters"]["satellites"]:
                if not item["count"]:
                    continue
                with np.load(self.storage_dir / identifier / f"{item['record_id']}.npz", allow_pickle=False) as data:
                    meshes[item["record_id"]] = {"vertices": data["vertices"].tolist(), "faces": data["faces"].tolist()}
            return {"meshes": meshes}

    def export_candidate(self, identifier, candidate_id):
        """返回指定方案的安装参数 XLSX；使用历史位姿和本体快照，不改变当前选定方案。"""
        with self._lock:
            job = self.get(identifier)
            return export_candidate_workbook(job, candidate_id, self.storage_dir / job["job_id"], self.models)

    def shutdown(self):
        """应用关闭时发出取消信号，不为无限搜索阻塞退出；重启会识别残留运行态。"""
        self._cancel.set()
