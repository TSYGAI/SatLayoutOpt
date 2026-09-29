"""
文件说明：把 STEP/STP 精确模型转换为保守外壳的交互与细节 GLB，并维护细节网格到 STEP 面的映射。
本模块只负责确定性派生产物生成；原始文件存储、任务串行和 HTTP 地址由模型上传服务管理。
"""

from __future__ import annotations

from datetime import datetime, timezone
import json
import math
from pathlib import Path
import struct
from typing import Iterable


GLB_JSON_CHUNK = 0x4E4F534A
GLB_BINARY_CHUNK = 0x004E4942
GLB_MAGIC = 0x46546C67
SHELL_POLICY = "conservative_exterior"
_CUBE_RAY_DIRECTIONS = tuple(
    (x / length, y / length, z / length)
    for x in (-1.0, 0.0, 1.0)
    for y in (-1.0, 0.0, 1.0)
    for z in (-1.0, 0.0, 1.0)
    if (x, y, z) != (0.0, 0.0, 0.0)
    for length in (math.sqrt((x * x) + (y * y) + (z * z)),)
)


def _pad_bytes(value: bytes, fill: bytes) -> bytes:
    """把字节串补齐到 GLB 要求的四字节边界。"""

    padding = (-len(value)) % 4
    return value + (fill * padding)


def _vector_tuple(vector: object) -> tuple[float, float, float]:
    """把 CadQuery Vector 转换为可序列化的三维浮点元组。"""

    values = vector.toTuple()
    return float(values[0]), float(values[1]), float(values[2])


def _surface_type(face: object) -> str:
    """安全读取 STEP 面的几何类型，异常时返回通用类型。"""

    try:
        return str(face.geomType())
    except Exception:
        return "OTHER"


def _shape_values(imported: object) -> list[object]:
    """返回 STEP 导入结果中的全部顶层形状。"""

    return list(imported.vals())


def _shape_faces(values: list[object]) -> tuple[list[object], int]:
    """从顶层形状提取全部 STEP 面，并返回顶层实体数量。"""

    faces: list[object] = []
    for value in values:
        faces.extend(value.Faces())
    return faces, len(values)


def _shape_solids(values: list[object]) -> list[object]:
    """提取顶层形状中的全部实体，用于判断是否具备可靠的封闭外壳。"""

    solids: list[object] = []
    for value in values:
        solids.extend(value.Solids())
    return solids


def _compound_shape(values: list[object], cadquery_module: object) -> object:
    """把一个或多个导入形状合成为射线求交使用的统一形状。"""

    if len(values) == 1:
        return values[0]
    return cadquery_module.Compound.makeCompound(values)


def _shape_bounds(values: list[object]) -> tuple[list[float], list[float]]:
    """读取所有顶层形状的精确轴对齐包围盒。"""

    boxes = [value.BoundingBox() for value in values]
    if not boxes:
        raise ValueError("STEP 模型没有可用于预览的形状")
    return (
        [min(getattr(box, name) for box in boxes) for name in ("xmin", "ymin", "zmin")],
        [max(getattr(box, name) for box in boxes) for name in ("xmax", "ymax", "zmax")],
    )


def _source_metadata(source_path: Path) -> dict:
    """生成用于派生产物失效判断的 STEP 源文件指纹。"""

    source_stat = source_path.stat()
    return {
        "format": "STEP",
        "role": "authoritative",
        "size": source_stat.st_size,
        "modified_ns": source_stat.st_mtime_ns,
    }


def _shell_parameters(parameters: dict) -> dict:
    """提取只影响外壳判断的稳定参数。"""

    return {
        "policy": str(parameters.get("shell_policy", SHELL_POLICY)),
        "samples_per_face": int(parameters["shell_samples_per_face"]),
        "ray_epsilon_ratio": float(parameters["shell_ray_epsilon_ratio"]),
        "direction_set": "cube_26",
        "preview_artifact_version": int(parameters["preview_artifact_version"]),
    }


def _shape_edges(faces: list[object]) -> list[object]:
    """从保留面提取并按 OpenCascade 拓扑标识去重的 STEP 边。"""

    edges: list[object] = []
    edges_by_hash: dict[int, list[object]] = {}
    for face in faces:
        for edge in face.Edges():
            try:
                edge_hash = int(edge.hashCode())
            except Exception:
                edge_hash = id(edge)
            same_hash_edges = edges_by_hash.setdefault(edge_hash, [])
            try:
                is_duplicate = any(edge.isSame(existing) for existing in same_hash_edges)
            except Exception:
                is_duplicate = bool(same_hash_edges)
            if is_duplicate:
                continue
            same_hash_edges.append(edge)
            edges.append(edge)
    return edges


def _edge_segments(
    edge: object,
    tessellation_tolerance: float,
) -> list[tuple[tuple[float, float, float], tuple[float, float, float]]]:
    """按细节公差把单条 STEP 拓扑边转为连续线段，失败时退化为端点连线。"""

    try:
        points, _ = edge.sample(tessellation_tolerance)
    except Exception:
        try:
            points = edge.Vertices()
        except Exception:
            return []
    polyline: list[tuple[float, float, float]] = []
    for point in points:
        vector = _vector_tuple(point)
        if not polyline or polyline[-1] != vector:
            polyline.append(vector)
    segments = [(start, end) for start, end in zip(polyline, polyline[1:]) if start != end]
    try:
        is_closed = bool(edge.IsClosed())
    except Exception:
        is_closed = False
    if is_closed and len(polyline) > 1 and polyline[-1] != polyline[0]:
        segments.append((polyline[-1], polyline[0]))
    return segments


def _float_bounds(points: Iterable[tuple[float, float, float]]) -> tuple[list[float], list[float]]:
    """计算一组顶点的轴对齐包围盒。"""

    point_list = list(points)
    if not point_list:
        raise ValueError("STEP 模型没有可用于预览的顶点")
    return (
        [min(point[axis] for point in point_list) for axis in range(3)],
        [max(point[axis] for point in point_list) for axis in range(3)],
    )


def _subtract(left: tuple[float, float, float], right: tuple[float, float, float]) -> tuple[float, float, float]:
    """计算三维向量差。"""

    return left[0] - right[0], left[1] - right[1], left[2] - right[2]


def _cross(left: tuple[float, float, float], right: tuple[float, float, float]) -> tuple[float, float, float]:
    """计算两个三维向量的叉积。"""

    return (
        (left[1] * right[2]) - (left[2] * right[1]),
        (left[2] * right[0]) - (left[0] * right[2]),
        (left[0] * right[1]) - (left[1] * right[0]),
    )


def _dot(left: tuple[float, float, float], right: tuple[float, float, float]) -> float:
    """计算两个三维向量的点积。"""

    return sum(left[index] * right[index] for index in range(3))


def _normalize(vector: tuple[float, float, float]) -> tuple[float, float, float] | None:
    """归一化非零向量，退化向量返回空值。"""

    length = math.sqrt(_dot(vector, vector))
    if length <= 1e-15:
        return None
    return tuple(value / length for value in vector)


def _triangle_samples(face: object, tolerance: float, angular_tolerance: float, limit: int) -> list[dict]:
    """从面粗网格中使用最远点策略选择代表性三角形中心与外向法线。"""

    vertices, triangles = face.tessellate(tolerance, angular_tolerance)
    positions = [_vector_tuple(vertex) for vertex in vertices]
    candidates: list[dict] = []
    for triangle in triangles:
        start, middle, end = (positions[int(index)] for index in triangle)
        cross = _cross(_subtract(middle, start), _subtract(end, start))
        normal = _normalize(cross)
        if normal is None:
            continue
        candidates.append({
            "point": tuple((start[axis] + middle[axis] + end[axis]) / 3 for axis in range(3)),
            "normal": normal,
            "area": math.sqrt(_dot(cross, cross)) * 0.5,
        })
    if len(candidates) <= limit:
        return candidates
    selected = [max(candidates, key=lambda candidate: candidate["area"])]
    remaining = [candidate for candidate in candidates if candidate is not selected[0]]
    while remaining and len(selected) < limit:
        def distance_score(candidate: dict) -> float:
            """返回候选点到已选点集合的最小平方距离。"""

            return min(
                _dot(_subtract(candidate["point"], item["point"]), _subtract(candidate["point"], item["point"]))
                for item in selected
            )

        next_sample = max(remaining, key=distance_score)
        selected.append(next_sample)
        remaining.remove(next_sample)
    return selected


def _face_is_externally_visible(
    face: object,
    samples: list[dict],
    intersector: object,
    ray_epsilon: float,
    ray_length: float,
) -> bool:
    """判断 STEP 面是否存在一条不被其他面遮挡的外向射线。"""

    from OCP.gp import gp_Dir, gp_Lin, gp_Pnt

    if not samples:
        return True
    for sample in samples:
        point = sample["point"]
        normal = sample["normal"]
        directions = [normal, *[direction for direction in _CUBE_RAY_DIRECTIONS if _dot(direction, normal) > 0.15]]
        start = tuple(point[index] + (normal[index] * ray_epsilon) for index in range(3))
        for direction in directions:
            try:
                line = gp_Lin(gp_Pnt(*start), gp_Dir(*direction))
                intersector.Perform(line, 0.0, ray_length)
                blocked = False
                for hit_index in range(1, intersector.NbPnt() + 1):
                    if float(intersector.WParameter(hit_index)) <= ray_epsilon * 10:
                        continue
                    hit_face = intersector.Face(hit_index)
                    if hit_face.IsSame(face.wrapped):
                        continue
                    blocked = True
                    break
                if not blocked:
                    return True
            except Exception:
                return True
    return False


def _faces_belong_to_closed_solids(faces: list[object], solids: list[object]) -> bool:
    """确认全部导入面都属于封闭实体，否则禁用可能误删面的外壳筛选。"""

    try:
        if not solids or any(not solid.isValid() for solid in solids):
            return False
        solid_faces = [face for solid in solids for face in solid.Faces()]
    except Exception:
        return False
    if len(solid_faces) < len(faces):
        return False
    try:
        return all(any(face.isSame(solid_face) for solid_face in solid_faces) for face in faces)
    except Exception:
        return False


def _compute_shell_map(
    imported_shape: object,
    faces: list[object],
    solids: list[object],
    bounds: tuple[list[float], list[float]],
    source: dict,
    parameters: dict,
) -> dict:
    """使用保守多方向射线判断外部可见面，并返回稳定 STEP 面 ID 集合。"""

    face_ids = [f"FACE_{index:05d}" for index in range(1, len(faces) + 1)]
    retained_ids = list(face_ids)
    fallback_reason = None
    if not _faces_belong_to_closed_solids(faces, solids):
        fallback_reason = "open_or_non_solid_shape"
    else:
        from OCP.IntCurvesFace import IntCurvesFace_ShapeIntersector

        lower, upper = bounds
        size = [upper[index] - lower[index] for index in range(3)]
        diagonal = max(math.sqrt(sum(value * value for value in size)), 1e-9)
        coarse_tolerance = max(max(size) * float(parameters["interaction_linear_ratio"]), 1e-6)
        angular_tolerance = math.radians(float(parameters["interaction_angular_degrees"]))
        ray_epsilon = max(diagonal * float(parameters["shell_ray_epsilon_ratio"]), 1e-7)
        ray_length = diagonal * 2.5
        try:
            intersector = IntCurvesFace_ShapeIntersector()
            intersector.Load(imported_shape.wrapped, ray_epsilon)
            retained_ids = []
            for face_id, face in zip(face_ids, faces):
                samples = _triangle_samples(
                    face,
                    coarse_tolerance,
                    angular_tolerance,
                    int(parameters["shell_samples_per_face"]),
                )
                if _face_is_externally_visible(face, samples, intersector, ray_epsilon, ray_length):
                    retained_ids.append(face_id)
        except Exception:
            retained_ids = list(face_ids)
            fallback_reason = "visibility_check_failed"
    retained_set = set(retained_ids)
    return {
        "format_version": 1,
        "source": source,
        "parameters": _shell_parameters(parameters),
        "retained_face_ids": retained_ids,
        "culled_face_ids": [face_id for face_id in face_ids if face_id not in retained_set],
        "fallback_reason": fallback_reason,
    }


def _load_shell_map(path: Path | None, source: dict, parameters: dict, face_count: int) -> dict | None:
    """读取并校验可复用的外壳面清单，内容异常时返回空值。"""

    if path is None:
        return None
    try:
        shell_map = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    all_ids = {f"FACE_{index:05d}" for index in range(1, face_count + 1)}
    retained = set(shell_map.get("retained_face_ids", []))
    culled = set(shell_map.get("culled_face_ids", []))
    if shell_map.get("source") != source or shell_map.get("parameters") != _shell_parameters(parameters):
        return None
    if retained | culled != all_ids or retained & culled:
        return None
    return shell_map


def _clear_triangulation(shape: object) -> None:
    """清除 OpenCascade 形状上缓存的离散网格，确保新的公差能够生效。"""

    from OCP.BRepTools import BRepTools

    BRepTools.Clean_s(shape.wrapped)


def _tessellate_faces(
    imported_shape: object,
    faces: list[object],
    retained_ids: set[str],
    tolerance: float,
    angular_tolerance: float,
) -> tuple[list[dict], list[tuple[float, float, float]]]:
    """按指定线性和角度公差离散保留面，并建立连续三角形范围。"""

    _clear_triangulation(imported_shape)
    face_records: list[dict] = []
    all_points: list[tuple[float, float, float]] = []
    triangle_cursor = 0
    for face_index, face in enumerate(faces, start=1):
        face_id = f"FACE_{face_index:05d}"
        if face_id not in retained_ids:
            continue
        try:
            vertices, triangles = face.tessellate(tolerance, angular_tolerance)
        except Exception as error:
            raise ValueError(f"STEP 面 {face_index} 三角化失败：{error}") from error
        positions = [_vector_tuple(vertex) for vertex in vertices]
        triangle_values = [tuple(int(index) for index in triangle) for triangle in triangles]
        if not positions or not triangle_values:
            continue
        node_name = f"STEP_FACE_{face_index:05d}"
        try:
            center = list(_vector_tuple(face.Center()))
            area = float(face.Area())
        except Exception:
            center = [0.0, 0.0, 0.0]
            area = 0.0
        face_records.append({
            "step_face_id": face_id,
            "node_name": node_name,
            "mesh_index": len(face_records),
            "triangle_start": triangle_cursor,
            "triangle_count": len(triangle_values),
            "vertex_count": len(positions),
            "surface_type": _surface_type(face),
            "area": area,
            "center": center,
            "positions": positions,
            "triangles": triangle_values,
        })
        triangle_cursor += len(triangle_values)
        all_points.extend(positions)
    if not face_records:
        raise ValueError("STEP 模型没有可生成浏览器外壳网格的有效面")
    return face_records, all_points


def _build_glb(
    face_records: list[dict],
    topology_edge_segments: list[tuple[tuple[float, float, float], tuple[float, float, float]]],
    destination: Path,
) -> None:
    """将逐面网格和可选 STEP 拓扑边线编码为 GLB 2.0。"""

    binary = bytearray()
    buffer_views: list[dict] = []
    accessors: list[dict] = []
    meshes: list[dict] = []
    nodes: list[dict] = []

    for record in face_records:
        positions = record["positions"]
        triangles = record["triangles"]
        position_bytes = b"".join(struct.pack("<fff", *point) for point in positions)
        position_offset = len(binary)
        binary.extend(position_bytes)
        buffer_views.append({
            "buffer": 0,
            "byteOffset": position_offset,
            "byteLength": len(position_bytes),
            "target": 34962,
        })
        lower, upper = _float_bounds(positions)
        accessors.append({
            "bufferView": len(buffer_views) - 1,
            "componentType": 5126,
            "count": len(positions),
            "type": "VEC3",
            "min": lower,
            "max": upper,
        })
        position_accessor = len(accessors) - 1

        index_values = [index for triangle in triangles for index in triangle]
        index_bytes = b"".join(struct.pack("<I", index) for index in index_values)
        index_offset = len(binary)
        binary.extend(index_bytes)
        buffer_views.append({
            "buffer": 0,
            "byteOffset": index_offset,
            "byteLength": len(index_bytes),
            "target": 34963,
        })
        accessors.append({
            "bufferView": len(buffer_views) - 1,
            "componentType": 5125,
            "count": len(index_values),
            "type": "SCALAR",
            "min": [min(index_values)],
            "max": [max(index_values)],
        })
        meshes.append({
            "name": record["node_name"],
            "primitives": [{
                "attributes": {"POSITION": position_accessor},
                "indices": len(accessors) - 1,
                "material": 0,
                "mode": 4,
            }],
        })
        nodes.append({
            "name": record["node_name"],
            "mesh": len(meshes) - 1,
            "extras": {"stepFaceId": record["step_face_id"]},
        })

    if topology_edge_segments:
        edge_positions = [point for segment in topology_edge_segments for point in segment]
        edge_bytes = b"".join(struct.pack("<fff", *point) for point in edge_positions)
        edge_offset = len(binary)
        binary.extend(edge_bytes)
        buffer_views.append({
            "buffer": 0,
            "byteOffset": edge_offset,
            "byteLength": len(edge_bytes),
            "target": 34962,
        })
        lower, upper = _float_bounds(edge_positions)
        accessors.append({
            "bufferView": len(buffer_views) - 1,
            "componentType": 5126,
            "count": len(edge_positions),
            "type": "VEC3",
            "min": lower,
            "max": upper,
        })
        meshes.append({
            "name": "STEP_TOPOLOGY_EDGES",
            "primitives": [{
                "attributes": {"POSITION": len(accessors) - 1},
                "material": 1,
                "mode": 1,
            }],
        })
        nodes.append({
            "name": "STEP_TOPOLOGY_EDGES",
            "mesh": len(meshes) - 1,
            "extras": {"role": "step_topology_edges"},
        })

    gltf = {
        "asset": {"version": "2.0", "generator": "SatLayoutOpt STEP LOD pipeline"},
        "scene": 0,
        "scenes": [{"nodes": list(range(len(nodes)))}],
        "nodes": nodes,
        "meshes": meshes,
        "materials": [{
            "name": "CAD neutral",
            "doubleSided": True,
            "pbrMetallicRoughness": {
                "baseColorFactor": [0.55, 0.62, 0.68, 1.0],
                "metallicFactor": 0.28,
                "roughnessFactor": 0.54,
            },
        }, {
            "name": "STEP topology edges",
            "doubleSided": True,
            "pbrMetallicRoughness": {
                "baseColorFactor": [0.12, 0.32, 0.4, 1.0],
                "metallicFactor": 0.0,
                "roughnessFactor": 1.0,
            },
        }],
        "accessors": accessors,
        "bufferViews": buffer_views,
        "buffers": [{"byteLength": len(binary)}],
    }
    json_chunk = _pad_bytes(json.dumps(gltf, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), b" ")
    binary_chunk = _pad_bytes(bytes(binary), b"\x00")
    total_length = 12 + 8 + len(json_chunk) + 8 + len(binary_chunk)
    with destination.open("wb") as output:
        output.write(struct.pack("<III", GLB_MAGIC, 2, total_length))
        output.write(struct.pack("<II", len(json_chunk), GLB_JSON_CHUNK))
        output.write(json_chunk)
        output.write(struct.pack("<II", len(binary_chunk), GLB_BINARY_CHUNK))
        output.write(binary_chunk)


def _quality_tessellation(
    imported_shape: object,
    faces: list[object],
    retained_ids: set[str],
    bounds: tuple[list[float], list[float]],
    quality: str,
    parameters: dict,
) -> tuple[list[dict], list[tuple[float, float, float]], float, float]:
    """生成指定质量网格，交互档会逐级放宽公差直至接近目标面数。"""

    lower, upper = bounds
    maximum_size = max((upper[index] - lower[index] for index in range(3)), default=0.0)
    maximum_size = max(maximum_size, 1e-6)
    if quality == "detail":
        linear_ratio = float(parameters["detail_linear_ratio"])
        angular_degrees = float(parameters["detail_angular_degrees"])
        records, points = _tessellate_faces(
            imported_shape,
            faces,
            retained_ids,
            max(maximum_size * linear_ratio, 1e-6),
            math.radians(angular_degrees),
        )
        return records, points, linear_ratio, angular_degrees

    linear_ratio = float(parameters["interaction_linear_ratio"])
    maximum_linear_ratio = float(parameters["interaction_max_linear_ratio"])
    angular_degrees = float(parameters["interaction_angular_degrees"])
    maximum_angular_degrees = float(parameters["interaction_max_angular_degrees"])
    target = int(parameters["interaction_triangle_target"])
    while True:
        records, points = _tessellate_faces(
            imported_shape,
            faces,
            retained_ids,
            max(maximum_size * linear_ratio, 1e-6),
            math.radians(angular_degrees),
        )
        triangle_count = sum(record["triangle_count"] for record in records)
        if triangle_count <= target or linear_ratio >= maximum_linear_ratio:
            return records, points, linear_ratio, angular_degrees
        linear_ratio = min(linear_ratio * 1.5, maximum_linear_ratio)
        angular_degrees = min(angular_degrees + 5.0, maximum_angular_degrees)


def generate_model_artifacts(
    source_path: Path,
    output_dir: Path,
    model: dict,
    quality: str,
    parameters: dict,
    reusable_shell_map_path: Path | None = None,
) -> dict:
    """解析 STEP 源文件并生成指定质量的外壳 GLB、清单及可选面映射。

    参数：
        source_path: 作为最终数据源的 STEP/STP 文件。
        output_dir: 本次生成使用的空目录。
        model: 对外展示的模型元数据。
        quality: `interaction` 或 `detail`。
        parameters: 统一配置传入的离散、外壳和版本参数。
        reusable_shell_map_path: 可选的已生成外壳面清单。
    返回：
        可直接持久化的该质量档派生产物清单。
    异常：
        ValueError: 参数无效、STEP 无法解析或没有可离散化的有效外壳面。
    副作用：
        在 output_dir 写入 preview.glb、manifest.json、shell-map.json 和可选 face-map.json。
    """

    if quality not in {"interaction", "detail"}:
        raise ValueError("模型预览质量档必须是 interaction 或 detail")
    try:
        import cadquery as cq

        imported = cq.importers.importStep(str(source_path))
        values = _shape_values(imported)
        faces, body_count = _shape_faces(values)
        solids = _shape_solids(values)
        imported_shape = _compound_shape(values, cq)
        bounds = _shape_bounds(values)
    except Exception as error:
        raise ValueError(f"STEP 模型解析失败：{error}") from error
    if not faces:
        raise ValueError("STEP 模型不包含可预览的几何面")

    source = _source_metadata(source_path)
    shell_map = _load_shell_map(reusable_shell_map_path, source, parameters, len(faces))
    if shell_map is None:
        shell_map = _compute_shell_map(imported_shape, faces, solids, bounds, source, parameters)
    retained_ids = set(shell_map["retained_face_ids"])
    face_records, all_points, actual_linear_ratio, actual_angular_degrees = _quality_tessellation(
        imported_shape,
        faces,
        retained_ids,
        bounds,
        quality,
        parameters,
    )

    topology_edges: list[object] = []
    topology_edge_segments: list[tuple[tuple[float, float, float], tuple[float, float, float]]] = []
    if quality == "detail":
        retained_faces = [face for index, face in enumerate(faces, start=1) if f"FACE_{index:05d}" in retained_ids]
        topology_edges = _shape_edges(retained_faces)
        maximum_size = max(bounds[1][index] - bounds[0][index] for index in range(3))
        edge_tolerance = max(maximum_size * actual_linear_ratio, 1e-6)
        topology_edge_segments = [
            segment
            for edge in topology_edges
            for segment in _edge_segments(edge, edge_tolerance)
        ]

    output_dir.mkdir(parents=True, exist_ok=False)
    glb_path = output_dir / "preview.glb"
    shell_map_path = output_dir / "shell-map.json"
    _build_glb(face_records, topology_edge_segments, glb_path)
    shell_map_path.write_text(json.dumps(shell_map, ensure_ascii=False, indent=2), encoding="utf-8")
    generated_at = datetime.now(timezone.utc).isoformat()
    triangle_count = sum(record["triangle_count"] for record in face_records)
    stats = {
        "body_count": body_count,
        "face_count": len(faces),
        "source_face_count": len(faces),
        "retained_face_count": len(shell_map["retained_face_ids"]),
        "culled_face_count": len(shell_map["culled_face_ids"]),
        "triangle_count": triangle_count,
        "detail_triangle_count": triangle_count if quality == "detail" else None,
        "interaction_triangle_count": triangle_count if quality == "interaction" else None,
        "vertex_count": sum(record["vertex_count"] for record in face_records),
        "edge_count": len(topology_edges),
        "edge_segment_count": len(topology_edge_segments),
    }
    mesh_bounds = _float_bounds(all_points)
    maximum_size = max(bounds[1][index] - bounds[0][index] for index in range(3))
    actual_linear_tolerance = max(maximum_size * actual_linear_ratio, 1e-6)
    manifest = {
        "format_version": 2,
        "generator": "SatLayoutOpt STEP exterior LOD pipeline",
        "quality": quality,
        "generated_at": generated_at,
        "model": model,
        "source": source,
        "browser_asset": {
            "format": "GLB",
            "role": "interaction_preview" if quality == "interaction" else "detail_preview_pick_quick_calc",
            "file_name": glb_path.name,
            "byte_size": glb_path.stat().st_size,
        },
        "parameters": {
            **parameters,
            "actual_linear_ratio": actual_linear_ratio,
            "actual_linear_tolerance": actual_linear_tolerance,
            "actual_angular_degrees": actual_angular_degrees,
            "actual_angular_radians": math.radians(actual_angular_degrees),
        },
        "shell_filter": {
            "policy": SHELL_POLICY,
            "source_face_count": len(faces),
            "retained_face_count": len(shell_map["retained_face_ids"]),
            "culled_face_count": len(shell_map["culled_face_ids"]),
            "fallback_reason": shell_map.get("fallback_reason"),
        },
        "bounds": {"min": bounds[0], "max": bounds[1]},
        "mesh_bounds": {"min": mesh_bounds[0], "max": mesh_bounds[1]},
        "stats": stats,
    }
    if quality == "detail":
        mapping_path = output_dir / "face-map.json"
        mapping_entries = [
            {key: value for key, value in record.items() if key not in {"positions", "triangles"}}
            for record in face_records
        ]
        mapping = {
            "format_version": 2,
            "model_id": model["id"],
            "source_format": "STEP",
            "mesh_format": "GLB",
            "quality": "detail",
            "generated_at": generated_at,
            "entries": mapping_entries,
        }
        mapping_path.write_text(json.dumps(mapping, ensure_ascii=False, indent=2), encoding="utf-8")
        manifest["face_mapping"] = {
            "format": "JSON",
            "role": "triangle_to_step_face",
            "file_name": mapping_path.name,
            "entry_count": len(mapping_entries),
        }
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return manifest
