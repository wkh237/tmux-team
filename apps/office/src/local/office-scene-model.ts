import { resolveAvatar } from '../avatars/avatar-catalog.js';
import type { AvatarCatalog } from '../avatars/avatar-catalog.js';
import type { ProfileProjection } from '../profiles/profile-contract.js';
import type { CatalogPack } from '../props/prop-contract.js';
import type { OfficeSceneModel } from '../rendering/office-scene.js';
import type { LocalBlockProjection } from './local-runtime.js';

/** A transient rendering projection of the existing admitted snapshot. */
export function officeSceneModel(
  profiles: ProfileProjection[],
  blocks: LocalBlockProjection[],
  avatars: AvatarCatalog,
  catalog: CatalogPack[]
): OfficeSceneModel {
  const layouts = new Map(blocks.map((block) => [block.identityId, block.layout.objects]));
  return {
    catalog,
    rooms: profiles.map((profile) => {
      const avatar = resolveAvatar(profile.profile.avatarRef, avatars);
      return {
        identityId: profile.identityId,
        name: profile.identityName,
        objects: layouts.get(profile.identityId) ?? [],
        avatar: profile.online
          ? {
              appearance: profile.profile.appearance,
              name: profile.identityName,
              displayLabel: profile.profile.displayLabel,
              customArt: avatar.status === 'available' ? avatar.art : undefined,
            }
          : undefined,
      };
    }),
  };
}
