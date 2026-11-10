/** 文件说明：显示微调正式包络与来源轮廓；共用安装材质及随视角更新的整流罩实虚线，尺寸更新保留主题、隐藏状态及场景身份。 */
import * as THREE from 'three';
import { buildCylinderMesh, buildFairingProfileMesh, buildInstallationBaseMesh, createInstallationSurfaceMaterial, resolveCylinderScenePalette, resolveContentBounds } from '../pre-config/cylinder-preview.js';
import { createLayoutGeometryCache } from '../../components/layout-geometry-cache.js';
import { createLayoutPlacementObjects } from '../../components/layout-placement-objects.js';
import { createCoordinateAxes } from '../../components/coordinate-axes.js';
import { createEnvelopeLights, applyEnvelopeLightTheme, resolveEnvelopeScenePalette } from '../../components/envelope-preview-appearance.js';
import { createRefinementDisplay } from './refinement-display.js';
import { createFairingBoundaryEdges } from '../../components/fairing-boundary-edges.js';

/** 将已生成的数组变为显示几何，调用方负责释放。 */
function buffer(data) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}

/** 创建安装空间和模型场景，更新位姿与筒尺寸时保持已有模型、来源轮廓及场景身份。 */
export function createRefinementScene(candidate, meshes, style, radialSegments, theme, source = candidate) {
  const scene = new THREE.Scene(), axes = createCoordinateAxes({ name: 'REFINEMENT_ORIGIN' });
  const cache = createLayoutGeometryCache(), space = new THREE.Group();
  const installation = new THREE.Group(); installation.name = 'refinement-installation'; space.add(installation);
  let fairingEdges = null;
  let dimensions = { radius: candidate.radius_mm, height: candidate.height_mm };
  const lights = createEnvelopeLights(theme);
  let activeTheme = theme, palette = resolveCylinderScenePalette(theme), display = createRefinementDisplay();
  scene.add(...Object.values(lights), axes, space);
  const base = candidate.installation_base, baseHeight = base.height_mm;
  const profile = candidate.fairing_profile;
  const total = profile.segments.reduce((sum, segment) => sum + segment.height_mm, 0);
  /** 向场景加入一个透明安装实体，所有位置以整流罩底面中心为原点。 */
  function addSpace(data, z, role) {
    if (!data) return;
    const shell = role === 'fairing-boundary';
    const geometry = buffer(data); geometry.translate(0, 0, z);
    const mesh = new THREE.Mesh(geometry, shell ? new THREE.MeshBasicMaterial({ color: palette.fairingBoundary,
      transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false }) : createInstallationSurfaceMaterial(activeTheme));
    mesh.renderOrder = 1;
    const edgeGeometry = data.edgeIndices ? new THREE.BufferGeometry()
      .setAttribute('position', geometry.getAttribute('position').clone()).setIndex(new THREE.BufferAttribute(data.edgeIndices, 1))
      : new THREE.EdgesGeometry(geometry, 30);
    if (shell) {
      mesh.userData.appearanceRole = role; mesh.visible = display.fairing;
      fairingEdges = createFairingBoundaryEdges({ surface: mesh, edgeGeometry, color: palette.fairingBoundaryEdge,
        opacity: palette.fairingBoundaryEdgeOpacity, style: style.fairingEdges });
      for (const line of fairingEdges.object.children) line.visible = display.fairing;
      space.add(mesh, fairingEdges.object);
      return;
    }
    const edges = new THREE.LineSegments(edgeGeometry, new THREE.LineBasicMaterial({
      color: palette.edge, transparent: true, opacity: 0.65 }));
    mesh.userData.appearanceRole = role; edges.userData.appearanceRole = role;
    mesh.visible = edges.visible = display[role === 'installation-tube' ? 'tube' : 'base'];
    installation.add(mesh, edges);
  }
  /** 尺寸已由后端验收，重建随半径变化的基座上底和筒侧壁，旧 GPU 资源立即释放。 */
  function updateInstallation(current) {
    for (const object of [...installation.children]) {
      object.geometry.dispose(); object.material.dispose(); installation.remove(object);
    }
    dimensions = { radius: current.radius_mm, height: current.height_mm };
    addSpace(buildCylinderMesh({ radius: dimensions.radius, height: dimensions.height, radialSegments }), baseHeight + dimensions.height / 2, 'installation-tube');
    addSpace(buildInstallationBaseMesh({ base, radius: dimensions.radius, radialSegments }), baseHeight / 2, 'installation-base');
  }
  addSpace(buildFairingProfileMesh({ profile, radialSegments }), total / 2, 'fairing-boundary');
  updateInstallation(candidate);
  const payload = createLayoutPlacementObjects(candidate, meshes, cache, style);
  scene.add(payload);
  const objects = new Map(payload.children.filter((item) => item.userData.instanceId).map((item) => [item.userData.instanceId, item]));
  const marker = payload.children.find((item) => !item.userData.instanceId);
  const ghosts = new THREE.Group(); ghosts.name = 'source-outlines'; ghosts.visible = false;
  for (const item of source.placements) {
    const outline = new THREE.LineSegments(objects.get(item.instance_id).children[0].geometry,
      new THREE.LineBasicMaterial({ color: style.optimizedColor, transparent: true, opacity: 0.25, depthWrite: false }));
    outline.userData.sharedLayoutGeometry = true; outline.userData.instanceId = item.instance_id; outline.matrixAutoUpdate = false;
    outline.matrix.set(...item.model_to_global_matrix.flat()); ghosts.add(outline);
  }
  scene.add(ghosts);
  const span = Math.max(candidate.fairing_radius_mm * 2, total);
  const target = new THREE.Vector3(0, 0, total / 2);
  /** 同步后端或即时草稿；选中成员整体变黄，取消选择后恢复固定、优化或违规配色。 */
  function update(current, selected, checked) {
    if (current.radius_mm !== dimensions.radius || current.height_mm !== dimensions.height) updateInstallation(current);
    for (const item of current.placements) {
      const object = objects.get(item.instance_id);
      object.matrix.set(...item.model_to_global_matrix.flat()); object.matrixWorldNeedsUpdate = true;
      const invalid = checked && item.constraint_violations?.length;
      const active = selected.includes(item.instance_id);
      const color = active ? style.selectedColor : invalid ? 0xd94a5c : item.fixed ? style.fixedColor : style.optimizedColor;
      object.material.color.setHex(color);
      object.material.emissive.setHex(active ? style.selectedColor : 0);
      object.material.emissiveIntensity = active ? 0.45 : 0;
      object.children[0].material.color.setHex(color);
    }
    marker.position.fromArray(current.validation.center_of_mass_mm);
  }
  /** 更新主题环境，不改模型、安装空间或视角。 */
  function setTheme(next) {
    activeTheme = next; palette = resolveCylinderScenePalette(next);
    scene.background = new THREE.Color(resolveEnvelopeScenePalette(next).background); applyEnvelopeLightTheme(lights, next);
    space.traverse((object) => {
      if (!object.material?.color) return;
      const shell = object.userData.appearanceRole === 'fairing-boundary';
      object.material.color.setHex(shell ? object.isLineSegments ? palette.fairingBoundaryEdge : palette.fairingBoundary
        : object.isLineSegments ? palette.edge : palette.body);
      if (shell && object.isLineSegments) object.material.opacity = palette.fairingBoundaryEdgeOpacity;
    });
  }
  setTheme(theme);
  return { scene, axes, objects, target, span, update, setTheme,
    /** 每个视口绘制前使用自己的相机同步罩体边线，四视图之间不共享可见性分类。 */
    updateFairingEdges(camera, viewportHeight) { fairingEdges?.update(camera, viewportHeight); },
    /** 返回当前视口的只读边线分类，供交互回归核对实时更新。 */
    fairingEdgeSnapshot() { return fairingEdges?.snapshot() ?? null; },
    /** 旋转中心沿用布局预览完整实体范围，包含罩体、筒体和卫星，排除坐标轴与来源辅助线。 */
    orbitBounds() { return resolveContentBounds(space).union(resolveContentBounds(payload)); },
    /** 全局取景以实际卫星与安装筒为边界，避免空整流罩占满画幅后压缩有效布局。 */
    layoutBounds() {
      scene.updateMatrixWorld(true);
      const bounds = new THREE.Box3(new THREE.Vector3(-dimensions.radius, -dimensions.radius, 0),
        new THREE.Vector3(dimensions.radius, dimensions.radius, baseHeight + dimensions.height));
      for (const object of objects.values()) bounds.expandByObject(object);
      return bounds;
    },
    /** 同步空间、逐星和辅助显示；隐藏成员的来源线一并隐藏，完整对象与包围范围仍保留供校核及稳定旋转。 */
    setDisplay(options) {
      display = { ...createRefinementDisplay(), ...options };
      const hidden = new Set(display.hiddenIds);
      ghosts.visible = display.original; marker.visible = display.centerOfMass; axes.visible = display.axes;
      for (const [id, object] of objects) object.visible = !hidden.has(id);
      for (const object of ghosts.children) object.visible = !hidden.has(object.userData.instanceId);
      space.traverse((object) => {
        const role = object.userData.appearanceRole;
        if (role) object.visible = display[role === 'fairing-boundary' ? 'fairing' : role === 'installation-tube' ? 'tube' : 'base'];
      });
    },
    /** 释放本视口材质与独占几何，缓存共享几何只释放一次。 */
    dispose() {
      scene.traverse((object) => {
        if (object.geometry && !object.userData.sharedLayoutGeometry) object.geometry.dispose();
        if (object.material) {
          object.material.map?.dispose(); object.material.dispose();
        }
      });
      cache.dispose(); scene.clear();
    } };
}
