import { useMemo } from 'react';
import type { BlockSceneProps } from '../blocks/block-scene.js';
import { defaultCatalog } from '../blocks/block-contract.js';
import { OfficeCanvas } from './office-canvas.js';

/** Renderer adapter only: the BlockEditor remains the sole draft/selection owner. */
export function RoomCanvas({
  identityId,
  name,
  ...props
}: BlockSceneProps & {
  identityId: string;
  name: string;
}) {
  const { objects, avatar, catalog, selected, select, move } = props;
  const model = useMemo(
    () => ({
      rooms: [{ identityId, name, objects, avatar }],
      catalog: catalog ?? defaultCatalog(),
    }),
    [identityId, name, objects, avatar, catalog]
  );
  return (
    <OfficeCanvas model={model} select={() => {}} editor={{ identityId, selected, select, move }} />
  );
}
