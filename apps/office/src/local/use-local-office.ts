import { useContext, useEffect, useState } from 'react';
import { LocalRuntimeContext } from './local-runtime.js';
import type { LocalBlockProjection, LocalRuntime } from './local-runtime.js';
import type { ProfileProjection, ProfileSnapshot } from '../profiles/profile-contract.js';
import type { AvatarCatalog } from '../avatars/avatar-catalog.js';
import type { CatalogPack } from '../props/prop-contract.js';

type OfficeLoad =
  | { status: 'loading'; runtime: LocalRuntime | undefined }
  | { status: 'error'; runtime: LocalRuntime | undefined }
  | {
      status: 'ready';
      runtime: LocalRuntime;
      blocks: LocalBlockProjection[];
      profiles: ProfileProjection[];
      avatars: AvatarCatalog;
      props: CatalogPack[];
    };

/** A mounted view's observation, never an alternate durable Office store. */
export function useLocalOffice() {
  const runtime = useContext(LocalRuntimeContext);
  const [generation, setGeneration] = useState(0);
  const [load, setLoad] = useState<OfficeLoad>({ status: 'loading', runtime });
  useEffect(() => {
    let active = true;
    if (!runtime) {
      setLoad({ status: 'error', runtime });
      return;
    }
    setLoad({ status: 'loading', runtime });
    void Promise.all([runtime.list(), runtime.profiles.list(), runtime.avatars.list()])
      .then(async ([blocks, profiles, avatars]) => {
        if (!active) return;
        const props = await runtime.resolveProps(blocks.flatMap((block) => block.layout.objects));
        if (active) setLoad({ status: 'ready', runtime, blocks, profiles, avatars, props });
      })
      .catch(() => {
        if (active) setLoad({ status: 'error', runtime });
      });
    return () => {
      active = false;
    };
  }, [runtime, generation]);
  function profileChanged(snapshot: ProfileSnapshot) {
    setLoad((current) =>
      current.status === 'ready' && current.runtime === runtime
        ? {
            ...current,
            profiles: current.profiles.map((item) =>
              item.identityId === snapshot.identityId ? { ...snapshot, online: item.online } : item
            ),
          }
        : current
    );
  }
  return {
    load: load.runtime === runtime ? load : { status: 'loading' as const, runtime },
    refresh: () => setGeneration((value) => value + 1),
    profileChanged,
  };
}
