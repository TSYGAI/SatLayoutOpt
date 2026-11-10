"""
文件说明：使用 OpenCascade 原生并行离散和 XCAF GLB 导出生成交互预览。
本模块输出完整网格和严格匹配导出顺序的 STEP 面映射，不负责外壳筛选或业务缓存。
"""

from __future__ import annotations

import json
import math
from pathlib import Path
import struct


def _read_glb_statistics(path: Path, face_metadata: dict) -> dict:
    """按场景遍历顺序统计网格并建立拾取映射；每个导出面节点固定为单位变换。"""

    with path.open("rb") as stream:
        header = stream.read(20)
        if len(header) != 20:
            raise ValueError("原生 GLB 文件头不完整")
        magic, version, total_length, json_length, json_type = struct.unpack("<IIIII", header)
        if magic != 0x46546C67 or version != 2 or total_length != path.stat().st_size:
            raise ValueError("原生 GLB 文件头无效")
        if json_type != 0x4E4F534A:
            raise ValueError("原生 GLB 缺少 JSON 块")
        document = json.loads(stream.read(json_length).decode("utf-8"))
    triangles = 0
    vertices = 0
    lower = [math.inf] * 3
    upper = [-math.inf] * 3
    records = []
    # 与 Three.js Object3D.traverse 的深度优先顺序一致，映射不依赖 OCC 内部枚举顺序。
    pending = list(reversed(document["scenes"][document.get("scene", 0)]["nodes"]))
    while pending:
        node = document["nodes"][pending.pop()]
        pending.extend(reversed(node.get("children", [])))
        if "mesh" not in node:
            continue
        mesh = document["meshes"][node["mesh"]]
        metadata = face_metadata[node["name"]]
        start = triangles
        vertex_start = vertices
        for primitive in mesh.get("primitives", []):
            if primitive.get("mode", 4) != 4:
                continue
            index_accessor = document.get("accessors", [])[primitive["indices"]] if "indices" in primitive else None
            if index_accessor is not None:
                triangles += int(index_accessor.get("count", 0)) // 3
            position_accessor = document.get("accessors", [])[primitive["attributes"]["POSITION"]]
            vertices += int(position_accessor.get("count", 0))
            lower = [min(lower[axis], position_accessor["min"][axis]) for axis in range(3)]
            upper = [max(upper[axis], position_accessor["max"][axis]) for axis in range(3)]
        records.append({**metadata, "mesh_index": node["mesh"], "triangle_start": start,
                        "triangle_count": triangles - start, "vertex_count": vertices - vertex_start})
    if not triangles or not vertices:
        raise ValueError("STEP 模型没有可生成交互网格的有效面")
    return {"triangle_count": triangles, "vertex_count": vertices, "mesh_bounds": (lower, upper), "face_records": records}


def write_native_interaction_mesh(
    shape: object,
    destination: Path,
    bounds: tuple[list[float], list[float]],
    parameters: dict,
    faces: list[object] | None = None,
) -> dict:
    """用 OCC 的并行 BRepMesh 和原生 XCAF GLB 写入完整交互网格。

    参数：
        shape: 已完成标准 STEP 修复的 CadQuery Shape。
        destination: 目标 GLB 路径。
        bounds: 模型精确包围盒，用于保持现有公差语义。
        parameters: 交互线性和角度公差参数。
        faces: 与标准 STEP 导入编号一致的面序列，省略时使用 shape.Faces()。
    返回：
        包含三角形、顶点及实际公差的统计字典。
    异常：
        ValueError: OCC 网格化或 GLB 导出失败。
    """

    from OCP.BRep import BRep_Builder
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.BRepTools import BRepTools
    from OCP.Message import Message_ProgressRange
    from OCP.RWGltf import RWGltf_CafWriter
    from OCP.RWMesh import RWMesh_CoordinateSystem_Yup
    from OCP.TColStd import TColStd_IndexedDataMapOfStringString
    from OCP.TCollection import TCollection_AsciiString, TCollection_ExtendedString
    from OCP.TDocStd import TDocStd_Document
    from OCP.TDataStd import TDataStd_Name
    from OCP.TopoDS import TopoDS_Compound
    from OCP.XCAFDoc import XCAFDoc_DocumentTool

    lower, upper = bounds
    maximum_size = max((upper[index] - lower[index] for index in range(3)), default=0.0)
    maximum_size = max(maximum_size, 1e-6)
    linear_ratio = float(parameters["interaction_linear_ratio"])
    angular_degrees = float(parameters["interaction_angular_degrees"])
    tolerance = max(maximum_size * linear_ratio, 1e-6)
    BRepTools.Clean_s(shape.wrapped)
    mesher = BRepMesh_IncrementalMesh(
        shape.wrapped,
        tolerance,
        True,
        math.radians(angular_degrees),
        True,
    )
    if not mesher.IsDone():
        raise ValueError("交互预览原生三维建模引擎网格化失败")
    destination.parent.mkdir(parents=True, exist_ok=True)
    document = TDocStd_Document(TCollection_ExtendedString("BinXCAF"))
    builder = BRep_Builder()
    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    metadata = {}
    ordered_faces = faces if faces is not None else shape.Faces()
    # 保存标准导入后的有序精确面，安装点保存可直接读取 BRep，无需再次解析整份 STEP。
    import cadquery as cq
    if not cq.Compound.makeCompound(ordered_faces).exportBin(str(destination.with_name("faces.brep"))):
        raise ValueError("快速预览精确面缓存写入失败")
    for index, face in enumerate(ordered_faces, start=1):
        # 每个面使用独立命名根节点并烘焙位置，既保留精确编号，也消除坐标单位歧义。
        compound = TopoDS_Compound()
        builder.MakeCompound(compound)
        builder.Add(compound, face.wrapped)
        label = shape_tool.AddShape(compound, False)
        name = f"STEP_FACE_{index:05d}"
        TDataStd_Name.Set_s(label, TCollection_ExtendedString(name))
        metadata[name] = {"step_face_id": f"FACE_{index:05d}", "node_name": name,
                          "surface_type": str(face.geomType()), "area": float(face.Area()),
                          "center": list(face.Center().toTuple())}
    writer = RWGltf_CafWriter(TCollection_AsciiString(str(destination)), True)
    converter = writer.ChangeCoordinateSystemConverter()
    # 禁止默认的 Z-up 到 Y-up 旋转及毫米到米缩放；浏览器按 STEP 原坐标解释网格。
    converter.SetInputCoordinateSystem(RWMesh_CoordinateSystem_Yup)
    converter.SetInputLengthUnit(1.0)
    writer.SetMergeFaces(True)
    if not writer.Perform(document, TColStd_IndexedDataMapOfStringString(), Message_ProgressRange()):
        raise ValueError("交互预览原生 GLB 导出失败")
    return {
        **_read_glb_statistics(destination, metadata),
        "actual_linear_ratio": linear_ratio,
        "actual_linear_tolerance": tolerance,
        "actual_angular_degrees": angular_degrees,
        "actual_angular_radians": math.radians(angular_degrees),
    }
