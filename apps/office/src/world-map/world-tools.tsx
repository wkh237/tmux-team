import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { OfficePopulation } from '../local/office-population.js';
import { AreaRemovalPreview } from './area-removal-preview.js';
import type { MeetingRoom } from '../local/room-contract.js';
import type { CatalogPack } from '../props/prop-contract.js';
import { removeArea } from './map-draft.js';
import { removeWorldObject, updateWorldMap } from './world-draft.js';
import type { useWorldEditor } from './use-world-editor.js';
import type { MapArea } from './map-contract.js';
import type { WorldObject } from './world-contract.js';
import { WorldObjectTools } from './world-object-tools.js';
import { suggestWallPlacement } from './world-object-placement.js';
import { resolvePlacedProp } from '../props/prop-contract.js';
import { WorldObjectAppearance } from './world-object-appearance.js';
import { addMeetingPreset } from './meeting-preset.js';
import { mapGeometry } from './map-source.js';
import { removeModule, setModuleMaterial } from './module-authoring.js';
import { RoomMaterialChoices } from './room-material-choices.js';
import { ModuleRemovalDialog } from './module-removal-dialog.js';
import type { PanelObstacles } from './use-anchored-panel.js';
import { upgradeModuleWorld, compactModuleWorld, platformModuleWorld } from './module-upgrade.js';
import { PropThumbnail } from '../props/prop-thumbnail.js';
import { WorldArtLibrary } from './world-art-library.js';

type Editor = ReturnType<typeof useWorldEditor>;
interface Props {
  obstacles?: PanelObstacles;
  creatingMeeting?: boolean;
  editor: Editor;
  content?: ReactNode;
  clearSelection: () => void;
  areaId: string | undefined;
  selectArea: (id: string) => void;
  objectId: string | undefined;
  selectObject: (id: string) => void;
  population: OfficePopulation;
  rooms: MeetingRoom[];
  catalog: CatalogPack[];
  addArt: (pack: CatalogPack, key: string) => void;
  openWorkshop: () => void;
}
export function WorldTools({
  obstacles,
  creatingMeeting,
  editor,
  content,
  clearSelection,
  areaId,
  selectArea,
  objectId,
  selectObject,
  population,
  rooms,
  catalog,
  addArt,
  openWorkshop,
}: Props) {
  const [replacement, setReplacement] = useState('');
  const [removingId, setRemovingId] = useState<string>();
  const [placementError, setPlacementError] = useState<string>();
  const library = !areaId && !objectId;
  const libraryId = useId();
  const libraryHeading = useRef<HTMLHeadingElement>(null);
  const objectHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (library) libraryHeading.current?.focus();
  }, [library]);
  useEffect(() => {
    objectHeading.current?.focus();
  }, [objectId]);
  const { world } = editor;
  const map = mapGeometry(world.map);
  const area = map.areas.find((value) => value.id === areaId);
  const [areaName, setAreaName] = useState(area?.name ?? '');
  useEffect(() => setAreaName(area?.name ?? ''), [area?.id, area?.name]);
  const meetingRoomId = area?.binding.type === 'meeting' ? area.binding.roomId : undefined;
  const object = world.objects.find((value) => value.id === objectId);
  const appearance = object ? resolvePlacedProp(catalog, object.placement) : undefined;
  function setObject(next: WorldObject) {
    editor.change((world) => ({
      ...world,
      objects: world.objects.map((item) => (item.id === next.id ? next : item)),
    }));
  }
  function setArea(next: MapArea) {
    editor.change((world) =>
      world.map.version !== 1
        ? {
            ...world,
            map: {
              ...world.map,
              modules: world.map.modules.map((module) =>
                module.area.id === next.id ? { ...module, area: next } : module
              ),
            },
          }
        : updateWorldMap(world, {
            ...world.map,
            areas: world.map.areas.map((area) => (area.id === next.id ? next : area)),
          })
    );
  }
  return (
    <div className="world-editor-hud" ref={obstacles?.viewport}>
      <section className="world-save-bar" aria-label="Layout changes">
        <div className="world-draft-history">
          <button disabled={!editor.canUndo || editor.busy} onClick={editor.undo}>
            Undo
          </button>
          <button disabled={!editor.canRedo || editor.busy} onClick={editor.redo}>
            Redo
          </button>
          <span role="status">
            {editor.saving
              ? 'Applying…'
              : editor.blocked
                ? 'Apply paused'
                : editor.dirty
                  ? 'Changes pending'
                  : 'All changes applied'}
          </span>
        </div>
        {editor.error && (
          <div role="alert">
            <p>{editor.error}</p>
            {editor.issues.map((issue, index) => (
              <p key={index}>
                {issue.objectId ? (
                  <button
                    onClick={() => {
                      selectObject(issue.objectId!);
                      objectHeading.current?.focus();
                    }}
                  >
                    Select affected object
                  </button>
                ) : (
                  'Map'
                )}{' '}
                · {issue.reason}
              </p>
            ))}
            <button disabled={editor.busy || editor.saving} onClick={() => void editor.retry()}>
              Retry changes
            </button>
            <button disabled={editor.busy || editor.saving} onClick={() => void editor.reload()}>
              Reload saved layout (discard local changes)
            </button>
          </div>
        )}
      </section>
      <aside className="world-build-inspector" aria-label="Layout tools">
        <div ref={obstacles?.above} className="world-build-tools">
          {!library && (
            <button disabled={editor.busy} onClick={clearSelection} aria-label="Clear selection">
              ← Furniture & devices
            </button>
          )}
        </div>
        <div hidden={creatingMeeting} className="world-build-content">
          {!object &&
            (world.map.version < 6 ||
              world.objects.some((item) => item.surface.type === 'wall')) && (
              <section aria-label="Platform layout preview">
                <p>
                  Convert to open platforms. Mounted objects become floor decorations; their content
                  and resource links are kept. Changes apply automatically.
                </p>
                <button disabled={editor.busy} onClick={() => editor.change(platformModuleWorld)}>
                  Convert to platforms
                </button>
                <p>
                  Connect neighboring offices with short bridges and separate the meeting wing. Room
                  contents stay together. Undo restores the previous layout.
                </p>
              </section>
            )}
          <fieldset disabled={editor.busy}>
            <section id={libraryId} hidden={!library} aria-label="Object library">
              <div className="world-art-heading">
                <h3 ref={libraryHeading} tabIndex={-1}>
                  Furniture & devices
                </h3>
                <button aria-label="Pixel workshop and art library" onClick={openWorkshop}>
                  Pixel workshop
                </button>
              </div>
              <p className="world-art-hint">
                Click a picture to add it to the last selected room. Drag objects directly on the
                map.
              </p>
              {library && (
                <WorldArtLibrary
                  catalog={catalog}
                  choose={(pack, key) => {
                    try {
                      addArt(pack, key);
                      setPlacementError(undefined);
                    } catch (cause) {
                      setPlacementError(
                        cause instanceof Error ? cause.message : 'Cannot place this object.'
                      );
                    }
                  }}
                />
              )}
            </section>
            {placementError && <p role="alert">{placementError}</p>}
            {!library && !object && area && (
              <section aria-label="Selected area">
                <h3>{area.name}</h3>
                {world.map.version !== 1 && (
                  <RoomMaterialChoices
                    platform={world.map.version >= 6}
                    value={
                      world.map.modules.find((module) => module.area.id === area.id)?.material ??
                      'workshop'
                    }
                    change={(material) =>
                      editor.change((world) => setModuleMaterial(world, area.id, material))
                    }
                  />
                )}
                <label>
                  Area name
                  <input
                    value={areaName}
                    maxLength={80}
                    onChange={(event) => {
                      const name = event.target.value;
                      setAreaName(name);
                      if (name.trim()) setArea({ ...area, name });
                    }}
                    onBlur={() => {
                      if (!areaName.trim()) setAreaName(area.name);
                    }}
                  />
                </label>
                {meetingRoomId !== undefined && (
                  <>
                    <details>
                      <summary>Meeting link</summary>
                      <label>
                        Linked meeting room
                        <select
                          value={meetingRoomId}
                          onChange={(event) =>
                            setArea({
                              ...area,
                              binding: { type: 'meeting', roomId: event.target.value },
                            })
                          }
                        >
                          {!rooms.some((room) => room.id === meetingRoomId) && (
                            <option value={meetingRoomId}>
                              Unavailable room · {meetingRoomId}
                            </option>
                          )}
                          {rooms.map((room) => (
                            <option key={room.id} value={room.id}>
                              {room.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <p>
                        Changing this link does not move members or retarget existing whiteboards or
                        discussion boards.
                      </p>
                    </details>
                    <button
                      onClick={() => editor.change((world) => addMeetingPreset(world, area.id))}
                    >
                      Add meeting set
                    </button>
                    <p>
                      Adds furniture, whiteboard, discussion board and radio. Needs a clear 36 × 32
                      space. Changes apply automatically; no messages are sent.
                    </p>
                  </>
                )}
                {area.binding.type === 'personal' && (
                  <label>
                    Resident
                    <select
                      value={area.binding.identityId ?? ''}
                      onChange={(event) =>
                        setArea({
                          ...area,
                          binding: { type: 'personal', identityId: event.target.value || null },
                        })
                      }
                    >
                      <option value="">Unassigned</option>
                      {[...population.identities.values()].map((profile) => (
                        <option
                          key={profile.identityId}
                          value={profile.identityId}
                          disabled={
                            profile.lifetime !== 'saved' ||
                            map.areas.some(
                              (other) =>
                                other.id !== area.id &&
                                other.binding.type === 'personal' &&
                                other.binding.identityId === profile.identityId
                            )
                          }
                        >
                          {profile.identityName} ·{' '}
                          {profile.lifetime === 'saved' ? 'Saved' : 'Contractor (ineligible)'}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {world.map.version !== 1 ? (
                  <>
                    <button disabled={editor.busy} onClick={() => setRemovingId(area.id)}>
                      Review module removal
                    </button>
                    {removingId === area.id && (
                      <ModuleRemovalDialog
                        world={world}
                        population={population.areas.get(area.id)!}
                        busy={editor.busy}
                        cancel={() => setRemovingId(undefined)}
                        confirm={() => {
                          const changed = editor.change((world) => removeModule(world, area.id));
                          if (changed) {
                            setRemovingId(undefined);
                            selectArea(world.map.primaryLobbyId);
                          }
                          return changed;
                        }}
                      />
                    )}
                  </>
                ) : (
                  <>
                    <AreaRemovalPreview world={world} population={population.areas.get(area.id)!} />
                    {area.id === world.map.primaryLobbyId && (
                      <label>
                        Replacement Lobby
                        <select
                          value={replacement}
                          onChange={(event) => setReplacement(event.target.value)}
                        >
                          <option value="">Select before removing</option>
                          {map.areas
                            .filter(
                              (other) => other.id !== area.id && other.binding.type === 'lobby'
                            )
                            .map((other) => (
                              <option key={other.id} value={other.id}>
                                {other.name}
                              </option>
                            ))}
                        </select>
                      </label>
                    )}
                    <button
                      disabled={area.id === world.map.primaryLobbyId && !replacement}
                      onClick={() =>
                        editor.change((world) =>
                          updateWorldMap(
                            world,
                            removeArea(mapGeometry(world.map), area.id, replacement)
                          )
                        )
                      }
                    >
                      Remove area designation
                    </button>
                  </>
                )}
              </section>
            )}
            {!library && object && (
              <>
                <div className="world-object-preview">
                  {appearance && (
                    <PropThumbnail pack={appearance.pack} prop={appearance.definition} />
                  )}
                  <h3
                    ref={objectHeading}
                    tabIndex={-1}
                    aria-label={`Selected object: ${appearance?.definition.label ?? 'Unavailable prop'}`}
                  >
                    {appearance?.definition.label ?? 'Unavailable prop'}
                  </h3>
                </div>
                <button
                  onClick={() => {
                    selectArea(areaId ?? world.map.primaryLobbyId);
                  }}
                >
                  Edit room settings
                </button>
                <WorldObjectTools
                  object={object}
                  wallEditing={world.map.version < 6}
                  identities={[...population.identities.values()]}
                  change={setObject}
                  mountOnWall={
                    world.map.version >= 6
                      ? undefined
                      : () => {
                          try {
                            const mounted = suggestWallPlacement(
                              world,
                              object,
                              areaId === undefined ? world.map.primaryLobbyId : areaId || null
                            );
                            setObject(mounted);
                            setPlacementError(undefined);
                          } catch (cause) {
                            setPlacementError(
                              cause instanceof Error ? cause.message : 'Cannot find a wall.'
                            );
                          }
                        }
                  }
                  remove={() => {
                    if (editor.change((world) => removeWorldObject(world, object.id)))
                      selectArea(areaId ?? world.map.primaryLobbyId);
                  }}
                />
                {appearance?.definition.customization && (
                  <WorldObjectAppearance
                    key={JSON.stringify([object.id, object.placement.customization])}
                    object={object}
                    {...appearance}
                    change={setObject}
                  />
                )}
              </>
            )}
          </fieldset>
          {!object && world.map.version < 4 && (
            <section aria-label="Modular layout upgrade">
              <button disabled={editor.busy} onClick={() => editor.change(upgradeModuleWorld)}>
                Preview modular layout
              </button>
              <details>
                <summary>What changes?</summary>
                <p>
                  {world.map.version === 1
                    ? 'Preview fixed rooms around a central 2×2 Lobby. Existing areas keep their names and bindings; room contents move together. Changes apply automatically. '
                    : 'Preview a central 2×2 Lobby with continuous corridors. Southern offices move one row with their contents; meeting rooms stay in place. Move corridor objects inside rooms first. '}
                  All placements are validated; Undo restores this layout.
                </p>
              </details>
            </section>
          )}
          {!object && world.map.version === 4 && (
            <section aria-label="Compact layout preview">
              <button disabled={editor.busy} onClick={() => editor.change(compactModuleWorld)}>
                Preview compact layout
              </button>
              <details>
                <summary>What changes?</summary>
                <p>
                  Remove unused corridor branches and close the gaps between meeting rooms. Room
                  contents move together. Undo restores this layout.
                </p>
              </details>
            </section>
          )}
          {content}
        </div>
      </aside>
    </div>
  );
}
