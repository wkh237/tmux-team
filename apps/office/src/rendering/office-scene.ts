import { Container, Graphics, Sprite } from 'pixi.js';
import type { SceneAvatar } from '../blocks/block-scene.js';
import type { CatalogPack } from '../props/prop-contract.js';
import type { WorldDocument } from '../world-map/world-contract.js';
import { avatarArt } from '../profiles/avatar-art.js';
import { AVATAR_LAYOUT, avatarMarkColor, avatarTopInset } from '../profiles/avatar-layout.js';
import { createSceneApplication } from './scene-application.js';
import { createSceneMaterials } from './scene-materials.js';
import { createSceneTextures } from './scene-textures.js';
import { createSceneFloor } from './scene-floor.js';
import { drawWall } from './scene-wall.js';
import { drawModuleGhost, moduleGhostGeometry } from './scene-module-ghost.js';
import { officeExpansionPassages, moduleSlotBounds } from '../world-map/module-geometry.js';
import { officeSlotKey } from '../world-map/module-contract.js';
import type { MeetingSlot, OfficeSlot } from '../world-map/module-contract.js';
import { mapGeometry } from '../world-map/map-source.js';
import { sceneLabel } from './scene-label.js';
import { sceneActorLabel, sceneNameplate } from './scene-nameplate.js';
import { drawSceneProp } from './scene-props.js';
import { drawSceneComponents } from './scene-components.js';
import type { SceneAction, SceneComponent } from './scene-component-geometry.js';
import { selectionAnchor, selectionTarget } from './selection-anchor.js';
import type { SelectionAnchor, SelectionTarget } from './selection-anchor.js';
import type { OfficeSelection } from './office-selection.js';
import {
  fitOfficeCamera,
  resizeOfficeCamera,
  scenePoint,
  zoomOfficeCamera,
  wheelOfficeCamera,
} from './office-geometry.js';
import type { SceneRect } from './office-geometry.js';
import { flatProjection } from './world-projection.js';
import { intersects, worldGeometry } from './world-geometry.js';

export interface OfficeActor {
  identityId: string;
  areaId: string;
  avatar: SceneAvatar;
  contractor: boolean;
  activity?: string;
}
export interface OfficeSceneModel {
  world: WorldDocument;
  actors: OfficeActor[];
  catalog: CatalogPack[];
  components: SceneAction[];
}
export interface OfficeSceneEditor {
  areaId: string;
  selectedMeeting?: MeetingSlot;
  tool: 'select' | 'move' | 'office';
  officeSlots?: readonly OfficeSlot[];
  selectedOffice?: OfficeSlot;
  chooseOffice?: (slot: OfficeSlot) => void;
  selected?: string;
  select?: (id: string) => void;
  moveObject: (id: string, position: { x: number; y: number }) => void;
}

export interface OfficeSceneEvents {
  select(selection: OfficeSelection): void;
  activate?(id: string): void;
  selectedAnchor?(anchor: SelectionAnchor | undefined): void;
  actorAnchor?(anchor: SelectionAnchor | undefined): void;
  officeAnchor?(target: SelectionTarget | undefined): void;
  meetingAnchor?(target: SelectionTarget | undefined): void;
  createMeeting?(slot: MeetingSlot): void;
}

/** Pixels and camera only. Every room, prop and door projects the world draft. */
export async function createOfficeScene(
  host: HTMLElement,
  signal: AbortSignal,
  {
    select,
    activate = () => {},
    selectedAnchor = () => {},
    actorAnchor = () => {},
    officeAnchor = () => {},
    meetingAnchor = () => {},
    createMeeting = () => {},
  }: OfficeSceneEvents
) {
  const runtime = await createSceneApplication(host, signal);
  if (!runtime) return undefined;
  const { application, invalidate, dispose: disposeApplication } = runtime;
  const root = new Container(),
    backdrop = new Graphics();
  application.stage.addChild(backdrop, root);
  const textures = createSceneTextures();
  let materials: Awaited<ReturnType<typeof createSceneMaterials>>;
  try {
    materials = await createSceneMaterials(signal);
  } catch (error) {
    disposeApplication();
    if (signal.aborted) return undefined;
    throw error;
  }
  if (!materials) return undefined;
  let model: OfficeSceneModel | undefined;
  let geometry: ReturnType<typeof worldGeometry> | undefined;
  const unprojectGround = (point: { x: number; y: number }) =>
    (geometry?.projection ?? flatProjection).unprojectGround(point);
  const projectGroundRect = (rect: SceneRect) =>
    (geometry?.projection ?? flatProjection).projectGroundRect(rect);
  const projectUpright = (rect: SceneRect) =>
    (geometry?.projection ?? flatProjection).projectUpright(rect);
  let camera = { x: 0, y: 0, scale: 1 };
  function cameraFrame() {
    return {
      x: 0,
      y: 0,
      width: Math.max(1, host.clientWidth),
      height: Math.max(1, host.clientHeight),
    };
  }
  let cameraViewport = cameraFrame();
  let fitted = false,
    disposed = false;
  let editor: OfficeSceneEditor | undefined;
  let selected: OfficeSelection | undefined;
  let anchoredActor: Extract<OfficeSelection, { kind: 'agent' }> | undefined;
  let focused: string | undefined, hovered: string | undefined;
  let componentLayer: ReturnType<typeof drawSceneComponents> | undefined;
  let nameplates: ReturnType<typeof sceneNameplate>[] = [];
  let actors: { actor: OfficeActor; bounds: SceneRect }[] = [];
  let renderedView: SceneRect | undefined;
  const preview = new Graphics(),
    highlight = new Graphics();
  const canvas = application.canvas;
  canvas.style.touchAction = 'none';
  canvas.tabIndex = -1;
  function viewport() {
    return {
      ...scenePoint(camera, 0, 0),
      width: Math.max(1, host.clientWidth) / camera.scale,
      height: Math.max(1, host.clientHeight) / camera.scale,
    };
  }
  function interaction(id?: string) {
    focused = id;
    if (componentLayer?.highlight(hovered ?? focused)) invalidate();
  }
  function selection(value?: OfficeSelection) {
    selected = value;
    highlight.clear();
    if (!model || !geometry) return;
    const view = viewport();
    for (const floor of value?.areaId ? geometry.visible(view).floors : [])
      if (floor.areaId === value?.areaId && intersects(view, floor))
        highlight
          .rect(floor.x, floor.y, floor.width, floor.height)
          .fill({ color: '#70ddc6', alpha: 0.12 });
    const object = model.world.objects.find((item) => item.id === editor?.selected);
    const rect = object && geometry.objectRect(object);
    if (rect)
      highlight
        .rect(rect.x, rect.y, rect.width, rect.height)
        .stroke({ color: '#ffe8a2', width: 0.25 });
    selectedAnchor(
      rect
        ? selectionAnchor(rect, camera, { width: host.clientWidth, height: host.clientHeight })
        : undefined
    );
    const actorRect = actors.find(
      ({ actor }) =>
        actor.identityId === anchoredActor?.identityId &&
        (!anchoredActor.areaId || actor.areaId === anchoredActor.areaId)
    )?.bounds;
    actorAnchor(
      actorRect
        ? selectionAnchor(actorRect, camera, { width: host.clientWidth, height: host.clientHeight })
        : undefined
    );
    officeAnchor(
      editor?.tool === 'office' && editor.selectedOffice
        ? selectionTarget(
            moduleGhostGeometry(editor.selectedOffice, geometry.projection).bounds,
            camera,
            {
              width: host.clientWidth,
              height: host.clientHeight,
            }
          )
        : undefined
    );
    meetingAnchor(
      geometry.meetingPreview
        ? selectionTarget(
            moduleGhostGeometry(geometry.meetingPreview.slot, geometry.projection).bounds,
            camera,
            { width: host.clientWidth, height: host.clientHeight }
          )
        : undefined
    );
    invalidate();
  }
  function anchorActor(value?: Extract<OfficeSelection, { kind: 'agent' }>) {
    anchoredActor = value;
    selection(selected);
  }
  function sky() {
    const width = Math.max(1, host.clientWidth),
      height = Math.max(1, host.clientHeight);
    backdrop.clear().rect(0, 0, width, height).fill('#040d20');
    // Fixed-cost distant haze stays in this single screen-space backdrop.
    // Layered translucent contours need neither blur textures nor a ticker.
    for (const [cx, cy, rx, ry, color] of [
      [0.08, 0.28, 0.42, 0.34, '#184269'],
      [0.91, 0.7, 0.36, 0.42, '#183853'],
      [0.53, 0.03, 0.28, 0.24, '#262947'],
    ] as const) {
      for (let ring = 24; ring > 0; ring--) {
        const radius = ring / 24;
        backdrop
          .ellipse(width * cx, height * cy, width * rx * radius, height * ry * radius)
          .fill({ color, alpha: 0.018 });
      }
    }
    if (editor && model && model.world.map.version !== 1) {
      for (let x = 0; x <= width; x += 32) backdrop.moveTo(x, 0).lineTo(x, height);
      for (let y = 0; y <= height; y += 32) backdrop.moveTo(0, y).lineTo(width, y);
      backdrop.stroke({ color: '#3b80b8', alpha: 0.13, width: 1 });
    }
    // Fixed seed and bounded screen density: distant dust, luminous stars and
    // sparse diffraction crosses. No ticker, blur filter or per-star display node.
    let seed = 291;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const count = Math.min(640, Math.max(80, Math.round((width * height) / 3000)));
    for (let i = 0; i < count; i++) {
      const x = Math.floor(random() * width),
        y = Math.floor(random() * height);
      const bright = i % 17 === 0,
        middle = i % 4 === 0;
      if (bright) {
        backdrop.circle(x, y, 12).fill({ color: '#3877d8', alpha: 0.035 });
        backdrop.circle(x, y, 7).fill({ color: '#559cfa', alpha: 0.08 });
        backdrop.circle(x, y, 3).fill({ color: '#82beff', alpha: 0.2 });
        backdrop.rect(x - 5, y, 11, 1).fill({ color: '#89c8ff', alpha: 0.5 });
        backdrop.rect(x, y - 7, 1, 15).fill({ color: '#89c8ff', alpha: 0.5 });
      }
      backdrop.rect(x, y, bright ? 2 : 1, bright ? 2 : 1).fill({
        color: bright ? '#e9f5ff' : middle ? '#a6caff' : '#5780b7',
        alpha: bright ? 0.95 : middle ? 0.65 : 0.35,
      });
    }
  }
  function draw() {
    if (!model || !geometry || !materials) return;
    root.removeChild(preview, highlight);
    for (const child of root.removeChildren()) child.destroy({ children: true });
    textures.begin();
    nameplates = [];
    actors = [];
    const visible = viewport();
    renderedView = {
      x: visible.x - 32,
      y: visible.y - 32,
      width: visible.width + 64,
      height: visible.height + 64,
    };
    const part = geometry.visible(renderedView);
    const areas = mapGeometry(model.world.map).areas;
    const finishes = new Map(
      model.world.map.version === 1
        ? []
        : model.world.map.modules.map((module) => [module.area.id, module.material] as const)
    );
    for (const rect of part.floors) {
      const finish = materials.forMaterial(finishes.get(rect.areaId ?? '') ?? 'workshop');
      const floor = createSceneFloor(finish.floor, rect);
      if (rect.areaId === null) floor.tint = '#839e98';
      root.addChild(floor);
    }
    const layers: { depth: number; node: Container; frontFace?: boolean }[] = [];
    for (const wall of part.walls) {
      const node = new Container();
      const finish = materials.forMaterial(
        wall.circulation ? 'workshop' : (finishes.get(wall.areaId ?? '') ?? 'workshop')
      );
      const { depth } = drawWall(
        node,
        wall,
        finish,
        geometry.projection,
        !!editor && wall.areaId === editor.areaId
      );
      layers.push({ depth, node, frontFace: wall.axis === 'horizontal' });
    }
    const components = new Map(model.components.map((component) => [component.id, component]));
    const functional: SceneComponent[] = [];
    for (const index of part.objects) {
      const object = model.world.objects[index]!,
        rect = geometry.objectRect(object);
      const component = components.get(object.id);
      if (component) {
        functional.push({ ...component, bounds: rect });
      }
      const group = new Container();
      const layer = new Container();
      if (object.kind === 'wallLight') {
        // Nested low-opacity halos fade toward the edge without a blur filter,
        // render texture or animation loop. Keep light local to its fixture.
        const glow = new Graphics();
        for (let ring = 0; ring < 8; ring++) {
          const radius = 1 - ring / 8;
          glow
            .ellipse(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2,
              rect.width * radius,
              rect.height * radius
            )
            .fill({ color: '#ffd28c', alpha: 0.014 });
        }
        layer.addChild(glow);
      }
      layer.addChild(group);
      layers.push({ depth: geometry.objectDepth(object), node: layer });
      // Every kind resolves the same immutable art and missing-art placeholder.
      // A light adds only a static glow; kind never substitutes a second asset.
      drawSceneProp(group, { ...object.placement, x: 0, y: 0 }, model.catalog, textures);
      if (object.surface.type === 'wall' && object.surface.axis === 'vertical') {
        group.rotation = object.surface.face === 'positive' ? Math.PI / 2 : -Math.PI / 2;
        group.position.set(
          rect.x + (object.surface.face === 'positive' ? rect.width : 0),
          rect.y + (object.surface.face === 'positive' ? 0 : rect.height)
        );
      } else group.position.set(rect.x, rect.y);
    }
    const actorLabels = new Container();
    const counts = new Map<string, number>();
    for (const actor of model.actors) {
      const index = counts.get(actor.areaId) ?? 0;
      counts.set(actor.areaId, index + 1);
      const slot = geometry.actorSlots(actor.areaId)[index];
      if (!slot) continue;
      const bounds = projectUpright(slot);
      if (!intersects(renderedView, bounds)) continue;
      const art = actor.avatar.customArt ?? avatarArt(actor.avatar.appearance);
      const sprite = new Sprite(textures.get(`avatar:${JSON.stringify(art)}`, art));
      sprite.position.set(bounds.x, bounds.y);
      sprite.width = bounds.width;
      sprite.height = bounds.height;
      const layer = new Container();
      layers.push({ depth: bounds.y + bounds.height, node: layer });
      layer.addChild(
        new Graphics()
          .ellipse(bounds.x + bounds.width / 2, bounds.y + bounds.height, 2.6, 0.6)
          .fill({ color: '#132e29', alpha: 0.3 }),
        sprite
      );
      sceneLabel(
        layer,
        actor.avatar.appearance.shirtMark,
        bounds.x + bounds.width / 2,
        bounds.y + AVATAR_LAYOUT.markCenterY,
        0.8,
        avatarMarkColor(art)
      ).anchor.set(0.5);
      nameplates.push(
        sceneActorLabel(
          actorLabels,
          `${actor.avatar.name}${actor.contractor ? ' · Contractor' : ''}`,
          actor.activity,
          bounds.x + bounds.width / 2,
          bounds.y + avatarTopInset(art) - 1
        )
      );
      actors.push({ actor, bounds });
    }
    if (editor?.tool === 'office')
      for (const slot of editor.officeSlots ?? []) {
        if (editor.selectedOffice && officeSlotKey(slot) !== officeSlotKey(editor.selectedOffice))
          continue;
        const node = new Container();
        if (model.world.map.version !== 1 && editor.selectedOffice) {
          const preview = new Graphics();
          for (const rect of officeExpansionPassages(model.world.map, slot)) {
            const passage = projectGroundRect(rect);
            preview.rect(passage.x, passage.y, passage.width, passage.height);
          }
          node.addChild(preview.fill({ color: '#5ce7ee', alpha: 0.16 }));
        }
        const bounds = drawModuleGhost(
          node,
          slot,
          Boolean(
            editor.selectedOffice && officeSlotKey(slot) === officeSlotKey(editor.selectedOffice)
          ),
          camera.scale,
          geometry.projection
        );
        layers.push({ depth: bounds.y + bounds.height, node });
      }
    if (geometry.meetingPreview) {
      const meeting = geometry.meetingPreview;
      const node = new Container();
      const path = new Graphics();
      node.addChild(path);
      for (const rect of meeting.passages) {
        const projected = geometry.projection.projectGroundRect(rect, null);
        path.rect(projected.x, projected.y, projected.width, projected.height);
      }
      path.fill({ color: '#5ce7ee', alpha: 0.12 });
      const bounds = drawModuleGhost(
        node,
        meeting.slot,
        editor?.selectedMeeting?.index === meeting.slot.index,
        camera.scale,
        geometry.projection
      );
      layers.push({ depth: bounds.y + bounds.height, node });
    }
    // At a shared ground edge the front face owns the corner silhouette; a side
    // body must not paint over its terminal post merely because it was added last.
    for (const { node } of layers.sort(
      (a, b) => a.depth - b.depth || Number(!!a.frontFace) - Number(!!b.frontFace)
    ))
      root.addChild(node);
    for (const area of areas) {
      const anchor = geometry.nameplate(area.id);
      if (anchor && intersects(renderedView, { ...anchor, width: 1, height: 1 }))
        nameplates.push(
          sceneNameplate(
            root,
            area.name,
            anchor.x,
            anchor.y,
            model.world.map.version === 1 ? 24 : 36,
            'bottom-center'
          )
        );
    }
    componentLayer = drawSceneComponents(root, functional);
    componentLayer.zoom(camera.scale);
    componentLayer.highlight(hovered ?? focused);
    // Actor information is a non-interactive overlay, above architectural
    // occlusion and object affordances rather than painted into the floor.
    root.addChild(actorLabels);
    for (const plate of nameplates) plate.zoom(camera.scale);
    root.addChild(highlight, preview);
    textures.end();
    selection(selected);
  }
  function applyCamera(force = false) {
    root.position.set(camera.x, camera.y);
    root.scale.set(camera.scale);
    const view = viewport();
    if (
      force ||
      !renderedView ||
      view.x < renderedView.x ||
      view.y < renderedView.y ||
      view.x + view.width > renderedView.x + renderedView.width ||
      view.y + view.height > renderedView.y + renderedView.height
    )
      draw();
    componentLayer?.zoom(camera.scale);
    for (const plate of nameplates) plate.zoom(camera.scale);
    selection(selected);
    invalidate();
  }
  function fit() {
    if (!geometry) return;
    const { projection } = geometry;
    cameraViewport = cameraFrame();
    let bounds = geometry.bounds;
    const slots = [
      ...(editor?.tool === 'office' ? (editor.officeSlots ?? []) : []),
      ...(geometry.meetingPreview ? [geometry.meetingPreview.slot] : []),
    ];
    if (slots.length) {
      const ghosts = slots.map((slot) => moduleGhostGeometry(slot, projection).bounds);
      const x = Math.min(bounds.x, ...ghosts.map((rect) => rect.x - 4));
      const y = Math.min(bounds.y, ...ghosts.map((rect) => rect.y - 4));
      const right = Math.max(
        bounds.x + bounds.width,
        ...ghosts.map((rect) => rect.x + rect.width + 4)
      );
      const bottom = Math.max(
        bounds.y + bounds.height,
        ...ghosts.map((rect) => rect.y + rect.height + 4)
      );
      bounds = { x, y, width: right - x, height: bottom - y };
    }
    camera = fitOfficeCamera(bounds, cameraViewport);
    fitted = true;
    sky();
    applyCamera(true);
  }
  function update(next: OfficeSceneModel) {
    const changed = model?.world !== next.world;
    model = next;
    if (changed) geometry = worldGeometry(next.world);
    if (!fitted) fit();
    else applyCamera(true);
  }
  function editing(next?: OfficeSceneEditor) {
    const enteringExpansion = editor?.tool !== 'office' && next?.tool === 'office';
    const redraw =
      Boolean(editor) !== Boolean(next) ||
      editor?.areaId !== next?.areaId ||
      editor?.tool !== next?.tool ||
      editor?.officeSlots !== next?.officeSlots ||
      editor?.selectedOffice !== next?.selectedOffice ||
      editor?.selectedMeeting?.index !== next?.selectedMeeting?.index;
    editor = next;
    preview.clear();
    if (redraw) sky();
    if (enteringExpansion) fit();
    else if (redraw) applyCamera(true);
    else selection(selected);
  }
  function at(event: PointerEvent) {
    const bounds = canvas.getBoundingClientRect();
    return scenePoint(camera, event.clientX - bounds.left, event.clientY - bounds.top);
  }
  let pointer:
    | {
        id: number;
        x: number;
        y: number;
        originX: number;
        originY: number;
        start: { x: number; y: number };
        draw: boolean;
        moved: boolean;
      }
    | undefined;
  function movedObject(point: { x: number; y: number }) {
    const object = model?.world.objects.find((item) => item.id === editor?.selected);
    if (!object || !pointer || !geometry) return undefined;
    const rect = geometry.objectRect(object);
    const grabbed = intersects(rect, { ...pointer.start, width: 0.001, height: 0.001 });
    const origin = grabbed
      ? { x: rect.x + point.x - pointer.start.x, y: rect.y + point.y - pointer.start.y }
      : { x: point.x - rect.width / 2, y: point.y - rect.height / 2 };
    const position = geometry.objectPosition(object, origin);
    return {
      id: object.id,
      position,
      rect: geometry.objectRect({
        ...object,
        placement: { ...object.placement, ...position },
      }),
    };
  }
  const down = (event: PointerEvent) => {
    if (event.button !== 0 && event.button !== 1) return;
    pointer = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      originX: camera.x,
      originY: camera.y,
      start: at(event),
      draw: Boolean(editor?.tool === 'move' && event.button === 0 && !event.shiftKey),
      moved: false,
    };
    canvas.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent) => {
    const point = at(event);
    if (!pointer) {
      hovered = editor ? undefined : componentLayer?.pick(point.x, point.y);
      canvas.style.cursor = hovered
        ? 'pointer'
        : editor && editor.tool !== 'select'
          ? 'crosshair'
          : 'grab';
      interaction(focused);
      return;
    }
    if (pointer.id !== event.pointerId) return;
    if (pointer.draw) {
      const rect = movedObject(point)?.rect;
      if (!rect) return;
      preview
        .clear()
        .rect(rect.x, rect.y, rect.width, rect.height)
        .fill({ color: '#70ddc6', alpha: 0.3 })
        .stroke({ color: '#c9fff1', width: 0.15 });
      invalidate();
      return;
    }
    const x = event.clientX - pointer.x,
      y = event.clientY - pointer.y;
    if (Math.hypot(x, y) > 5) pointer.moved = true;
    if (pointer.moved) {
      camera = { ...camera, x: pointer.originX + x, y: pointer.originY + y };
      applyCamera();
    }
  };
  const up = (event: PointerEvent) => {
    if (!pointer || pointer.id !== event.pointerId) return;
    const point = at(event);
    if (event.type !== 'pointercancel') {
      if (pointer.draw) {
        if (editor?.tool === 'move') {
          const moved = movedObject(point);
          if (moved) editor.moveObject(moved.id, moved.position);
        }
      } else if (!pointer.moved) {
        if (
          geometry?.meetingPreview &&
          intersects(
            moduleGhostGeometry(geometry.meetingPreview.slot, geometry.projection).bounds,
            { ...point, width: 0.001, height: 0.001 }
          )
        ) {
          createMeeting(geometry.meetingPreview.slot);
        } else if (editor?.tool === 'office' && geometry) {
          const version = geometry.projection.version;
          const ground = unprojectGround(point);
          const selectedSlot = editor.selectedOffice;
          const slot = editor.officeSlots?.find(
            (slot) =>
              (!selectedSlot || officeSlotKey(slot) === officeSlotKey(selectedSlot)) &&
              intersects(moduleSlotBounds(slot, version), {
                ...ground,
                width: 0.001,
                height: 0.001,
              })
          );
          if (slot) editor.chooseOffice?.(slot);
        } else if (editor && geometry) {
          const currentGeometry = geometry;
          const object = [...(model?.world.objects ?? [])].reverse().find((item) =>
            intersects(currentGeometry.objectRect(item), {
              ...point,
              width: 0.001,
              height: 0.001,
            })
          );
          if (object) editor.select?.(object.id);
          else {
            const ground = unprojectGround(point);
            const area = geometry?.map.areaAt(Math.floor(ground.x), Math.floor(ground.y));
            if (area) select({ kind: 'area', areaId: area });
          }
        } else {
          const component = componentLayer?.pick(point.x, point.y);
          const actor = [...actors]
            .reverse()
            .find((entry) => intersects(entry.bounds, { ...point, width: 0.001, height: 0.001 }));
          if (component) {
            canvas.focus({ preventScroll: true });
            activate(component);
          } else if (actor)
            select({
              kind: 'agent',
              identityId: actor.actor.identityId,
              areaId: actor.actor.areaId,
            });
          else {
            const ground = unprojectGround(point);
            const area = geometry?.map.areaAt(Math.floor(ground.x), Math.floor(ground.y));
            if (area) select({ kind: 'area', areaId: area });
          }
        }
      }
    }
    preview.clear();
    invalidate();
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    pointer = undefined;
  };
  function zoom(factor: number, x = host.clientWidth / 2, y = host.clientHeight / 2) {
    if (!geometry) return;
    const fitted = fitOfficeCamera(geometry.bounds, cameraFrame());
    camera = zoomOfficeCamera(camera, factor, x, y, fitted.scale, Math.max(fitted.scale, 8));
    applyCamera(true);
  }
  const wheel = (event: WheelEvent) => {
    event.preventDefault();
    if (!geometry) return;
    const bounds = canvas.getBoundingClientRect();
    const fitted = fitOfficeCamera(geometry.bounds, cameraFrame());
    camera = wheelOfficeCamera(
      camera,
      event,
      event.clientX - bounds.left,
      event.clientY - bounds.top,
      bounds.height,
      fitted.scale,
      Math.max(fitted.scale, 8)
    );
    applyCamera(true);
  };
  const resize = () => {
    const next = cameraFrame();
    if (geometry) camera = resizeOfficeCamera(camera, geometry.bounds, cameraViewport, next);
    cameraViewport = next;
    sky();
    applyCamera(true);
  };
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', wheel, { passive: false });
  application.renderer.on('resize', resize);
  function dispose() {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener('abort', dispose);
    canvas.removeEventListener('pointerdown', down);
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', up);
    canvas.removeEventListener('pointercancel', up);
    canvas.removeEventListener('wheel', wheel);
    if (application.renderer) application.renderer.off('resize', resize);
    disposeApplication();
    textures.dispose();
    materials?.dispose();
  }
  signal.addEventListener('abort', dispose, { once: true });
  return { update, selection, interaction, editing, anchorActor, fit, zoom, dispose };
}
