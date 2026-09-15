import { Container, Graphics, Sprite, Text, TilingSprite } from 'pixi.js';
import type { Furniture } from '../blocks/block-contract.js';
import { footprint, validFurniture } from '../blocks/block-contract.js';
import type { CatalogPack } from '../props/prop-contract.js';
import { resolvedProp } from '../props/prop-contract.js';
import type { SceneAvatar } from '../blocks/block-scene.js';
import { avatarArt } from '../profiles/avatar-art.js';
import { createSceneApplication } from './scene-application.js';
import { createSceneMaterials } from './scene-materials.js';
import { createSceneTextures } from './scene-textures.js';
import { furnitureAt } from './furniture-picking.js';
import { drawRoomEnvelope } from './room-envelope.js';
import {
  fitOfficeCamera,
  officeGeometry,
  scenePoint,
  zoomOfficeCamera,
} from './office-geometry.js';

export interface OfficeSceneRoom {
  identityId: string;
  name: string;
  objects: Furniture[];
  avatar?: SceneAvatar;
}
export interface OfficeSceneModel {
  rooms: OfficeSceneRoom[];
  catalog: CatalogPack[];
}
export interface OfficeSceneEditor {
  identityId: string;
  selected?: number | null;
  select?: (index: number) => void;
  move?: (x: number, y: number) => void;
}

function label(
  parent: Container,
  text: string,
  x: number,
  y: number,
  size: number,
  color = '#f6edcf',
  wrapWidth = 28
) {
  // Rasterize readable glyphs, then scale into tile units. Rasterizing a one-pixel
  // font and enlarging it with the camera makes labels illegible.
  const fontSize = 16;
  const item = new Text({
    text,
    style: {
      fontFamily: 'system-ui',
      fontSize,
      fill: color,
      wordWrap: true,
      wordWrapWidth: (wrapWidth * fontSize) / size,
    },
  });
  item.scale.set(size / fontSize);
  item.position.set(x, y);
  parent.addChild(item);
  return item;
}

/** One controlled scene: it owns pixels and camera, never identities or saved layouts. */
export async function createOfficeScene(
  host: HTMLElement,
  signal: AbortSignal,
  select: (id: string) => void
) {
  const runtime = await createSceneApplication(host, signal);
  if (!runtime) return undefined;
  const { application, invalidate, dispose: disposeApplication } = runtime;
  const textures = createSceneTextures();
  const root = new Container();
  application.stage.addChild(root);
  let materials: Awaited<ReturnType<typeof createSceneMaterials>>;
  try {
    materials = await createSceneMaterials(signal);
  } catch (error) {
    disposeApplication();
    if (signal.aborted) return undefined;
    throw error;
  }
  if (!materials) return undefined;
  const { floor, wall } = materials;
  // The surrounding circulation floor fills the viewport without inventing
  // rooms or saved furniture. Reuse the same texture and camera grid.
  const surroundings = new TilingSprite({ texture: floor, width: 1, height: 1 });
  surroundings.tint = '#a9af97';
  surroundings.alpha = 0.3;
  application.stage.addChildAt(surroundings, 0);
  let geometry = officeGeometry([]);
  let camera = { x: 0, y: 0, scale: 1 };
  let fitted = false;
  let disposed = false;
  const highlight = new Graphics();
  const furnitureHighlight = new Graphics();
  const placementPreview = new Graphics();
  let previewKey: string | undefined;
  let model: OfficeSceneModel = { rooms: [], catalog: [] };
  let editor: OfficeSceneEditor | undefined;
  let selectedId: string | undefined;
  const applyCamera = () => {
    root.position.set(camera.x, camera.y);
    root.scale.set(camera.scale);
    surroundings.width = host.clientWidth;
    surroundings.height = host.clientHeight;
    surroundings.tileScale.set((32 * camera.scale) / floor.width);
    surroundings.tilePosition.set(camera.x, camera.y);
    invalidate();
  };
  function fit() {
    const wide = host.clientWidth >= 760;
    const left = wide && !editor ? 270 : 24;
    const right = wide && (selectedId || editor) ? 350 : 24;
    camera = fitOfficeCamera(geometry.bounds, {
      x: left,
      y: 100,
      width: Math.max(1, host.clientWidth - left - right),
      height: Math.max(1, host.clientHeight - (editor && !wide ? 460 : 170)),
    });
    fitted = true;
    applyCamera();
  }
  function selection(id: string | undefined) {
    const changedInsets = Boolean(selectedId) !== Boolean(id);
    selectedId = id;
    highlight.clear();
    const room = geometry.rooms.find((item) => item.identityId === id);
    if (room)
      highlight
        .rect(room.x - 0.7, room.y - 0.7, room.width + 1.4, room.height + 1.4)
        .stroke({ color: '#f1c56b', width: 0.35 });
    if (changedInsets && fitted) fit();
    invalidate();
  }
  function editing(next: OfficeSceneEditor | undefined, redraw = false) {
    const changedMode = Boolean(editor) !== Boolean(next);
    const changedPresentation =
      editor?.identityId !== next?.identityId ||
      editor?.selected !== next?.selected ||
      Boolean(editor?.move) !== Boolean(next?.move);
    editor = next;
    if (!redraw && !changedMode && !changedPresentation) return;
    clearPreview();
    furnitureHighlight.clear();
    const room = geometry.rooms.find((value) => value.identityId === editor?.identityId);
    const source = model.rooms.find((value) => value.identityId === editor?.identityId);
    const item = editor?.selected == null ? undefined : source?.objects[editor.selected];
    if (room && item) {
      const size = footprint(item);
      furnitureHighlight
        .rect(room.x + item.x, room.y + item.y, size.width, size.height)
        .stroke({ color: '#ffe8a2', width: 0.2 });
    }
    if (changedMode) fit();
    invalidate();
  }
  function update(next: OfficeSceneModel) {
    model = next;
    root.removeChild(highlight);
    root.removeChild(furnitureHighlight);
    root.removeChild(placementPreview);
    for (const child of root.removeChildren()) child.destroy({ children: true });
    textures.begin();
    const nextGeometry = officeGeometry(model.rooms.map((room) => room.identityId));
    const changedBounds =
      geometry.bounds.width !== nextGeometry.bounds.width ||
      geometry.bounds.height !== nextGeometry.bounds.height;
    geometry = nextGeometry;
    const hall = new TilingSprite({
      texture: floor,
      width: geometry.bounds.width,
      height: geometry.bounds.height,
    });
    hall.tileScale.set(32 / floor.width);
    root.addChild(hall);
    for (const [index, room] of geometry.rooms.entries()) {
      const source = model.rooms[index]!;
      drawRoomEnvelope(root, room, floor, wall);
      const objects = new Container();
      objects.position.set(room.x, room.y);
      root.addChild(objects);
      for (const item of source.objects) {
        const [digest, key] = item.prop.split('/');
        const pack = model.catalog.find((candidate) => candidate.digest === digest)?.pack;
        const prop = pack && key ? resolvedProp(pack, key, item.footprint) : undefined;
        const size = footprint(item);
        if (!pack || !prop) {
          objects.addChild(
            new Graphics()
              .rect(item.x, item.y, size.width, size.height)
              .fill({ color: '#9e6849', alpha: 0.4 })
              .stroke({ color: '#f5d890', width: 0.15 })
          );
          continue;
        }
        const sprite = new Sprite(
          textures.get(item.prop, { pixels: prop.pixels, palette: pack.palette })
        );
        sprite.anchor.set(0.5);
        sprite.width = item.footprint.width;
        sprite.height = item.footprint.height;
        sprite.position.set(item.x + size.width / 2, item.y + size.height / 2);
        sprite.rotation = (item.rotation * Math.PI) / 2;
        objects.addChild(sprite);
      }
      if (source.avatar) {
        const avatar = source.avatar;
        const art = avatar.customArt ?? avatarArt(avatar.appearance);
        const key = JSON.stringify(art);
        const sprite = new Sprite(textures.get(`avatar:${key}`, art));
        sprite.width = 5.6;
        sprite.height = 8.4;
        sprite.position.set(21.2, 19);
        objects.addChild(
          new Graphics().ellipse(24, 27.5, 2.8, 0.7).fill({ color: '#26352b', alpha: 0.22 })
        );
        objects.addChild(sprite);
        label(objects, avatar.name, 24, 16.8, 1.1, '#293d2e').anchor.set(0.5, 0);
        label(objects, avatar.appearance.shirtMark, 24, 24.2, 0.8).anchor.set(0.5, 0);
      }
      root.addChild(
        new Graphics()
          .roundRect(room.x + 1, room.y + room.height + 0.3, 20, 2.8, 0.25)
          .fill('#314d3f')
      );
      label(
        root,
        `${source.name}${source.avatar ? '' : ' · Offline'}`,
        room.x + 2,
        room.y + room.height + 0.6,
        1.05,
        '#f6edcf',
        18
      );
    }
    const commons = geometry.commons;
    root.addChild(
      new Graphics()
        .rect(commons.x + 1.3, commons.y + 3.3, 14, 5)
        .fill({ color: '#253c31', alpha: 0.25 })
        .rect(commons.x + 1, commons.y + 3, 14, 5)
        .fill('#97704c')
        .rect(commons.x + 1.4, commons.y + 3.4, 13.2, 4.2)
        .fill('#304e43')
        .rect(commons.x + 1, commons.y + 7.6, 14, 0.4)
        .fill('#d2ad78')
    );
    label(root, 'THE COMMONS', commons.x + 2, commons.y + 4, 1, '#f6edcf', 12);
    label(root, 'Ideas & conversations', commons.x + 18, commons.y + 4, 1, '#314b34', 12);
    root.addChild(highlight);
    root.addChild(furnitureHighlight);
    root.addChild(placementPreview);
    selection(selectedId);
    editing(editor, true);
    textures.end();
    if (!fitted || changedBounds) fit();
    invalidate();
  }
  let pointer:
    | { id: number; x: number; y: number; originX: number; originY: number; moved: boolean }
    | undefined;
  const canvas = application.canvas;
  canvas.style.touchAction = 'none';
  function clearPreview() {
    if (previewKey === undefined) return;
    previewKey = undefined;
    placementPreview.clear();
    canvas.removeAttribute('aria-description');
    invalidate();
  }
  function preview(event: PointerEvent) {
    const room = geometry.rooms.find((value) => value.identityId === editor?.identityId);
    const source = model.rooms.find((value) => value.identityId === editor?.identityId);
    const item = editor?.selected == null ? undefined : source?.objects[editor.selected];
    if (!room || !item || !editor?.move) return clearPreview();
    const bounds = canvas.getBoundingClientRect();
    const point = scenePoint(camera, event.clientX - bounds.left, event.clientY - bounds.top);
    const x = Math.floor(point.x - room.x),
      y = Math.floor(point.y - room.y);
    if (
      x < 0 ||
      y < 0 ||
      x >= room.width ||
      y >= room.height ||
      furnitureAt(source?.objects ?? [], x, y) !== undefined
    )
      return clearPreview();
    const key = `${x}:${y}`;
    if (key === previewKey) return;
    previewKey = key;
    const valid = validFurniture({ ...item, x, y });
    const size = footprint(item);
    const color = valid ? '#b9e39a' : '#ef937c';
    placementPreview
      .clear()
      .rect(room.x + x, room.y + y, size.width, size.height)
      .fill({ color, alpha: 0.3 })
      .stroke({ color, width: 0.2 });
    canvas.setAttribute(
      'aria-description',
      `Placement preview: tile ${x}, ${y}${valid ? '' : ', outside room bounds'}. Click to place.`
    );
    invalidate();
  }
  const down = (event: PointerEvent) => {
    if (event.button !== 0) return;
    clearPreview();
    pointer = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      originX: camera.x,
      originY: camera.y,
      moved: false,
    };
    canvas.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent) => {
    if (!pointer) return preview(event);
    if (pointer.id !== event.pointerId) return;
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
    if (!pointer.moved && event.type !== 'pointercancel') {
      const bounds = canvas.getBoundingClientRect();
      const point = scenePoint(camera, event.clientX - bounds.left, event.clientY - bounds.top);
      const room = geometry.rooms.find(
        (item) =>
          point.x >= item.x &&
          point.y >= item.y &&
          point.x < item.x + item.width &&
          point.y < item.y + item.height
      );
      if (room && editor?.identityId === room.identityId) {
        const source = model.rooms.find((value) => value.identityId === room.identityId);
        const x = Math.floor(point.x - room.x),
          y = Math.floor(point.y - room.y);
        const index = furnitureAt(source?.objects ?? [], x, y);
        if (index === undefined) editor.move?.(x, y);
        else editor.select?.(index);
      } else if (room) select(room.identityId);
    }
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    pointer = undefined;
  };
  const wheel = (event: WheelEvent) => {
    event.preventDefault();
    clearPreview();
    const bounds = canvas.getBoundingClientRect();
    const scale = Math.max(1, Math.min(30, camera.scale * Math.exp(-event.deltaY * 0.001)));
    camera = zoomOfficeCamera(
      camera,
      scale,
      event.clientX - bounds.left,
      event.clientY - bounds.top
    );
    applyCamera();
  };
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('pointerleave', clearPreview);
  canvas.addEventListener('wheel', wheel, { passive: false });
  application.renderer.on('resize', fit);
  function dispose() {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener('abort', dispose);
    canvas.removeEventListener('pointerdown', down);
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', up);
    canvas.removeEventListener('pointercancel', up);
    canvas.removeEventListener('pointerleave', clearPreview);
    canvas.removeEventListener('wheel', wheel);
    // The application abort listener may already have disposed its renderer.
    if (application.renderer) application.renderer.off('resize', fit);
    disposeApplication();
    textures.dispose();
    materials?.dispose();
  }
  signal.addEventListener('abort', dispose, { once: true });
  return { update, selection, editing, fit, dispose };
}
