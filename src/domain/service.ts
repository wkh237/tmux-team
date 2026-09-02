import { normalizeName, validateName } from './names.js';
import type { ActiveRegistration, BindingResult } from './types.js';

export function bindGlobalName(
  registrations: readonly ActiveRegistration[],
  name: string,
  paneId: string
): BindingResult<readonly ActiveRegistration[]> {
  const valid = validateName(name);
  if (!valid.ok) return valid;
  const samePane = registrations.find((entry) => entry.paneId === paneId);
  if (samePane) {
    if (samePane.canonicalName === valid.value.canonicalName)
      return { ok: true, value: registrations };
    return {
      ok: false,
      error: { code: 'PANE_ALREADY_BOUND', message: 'Pane is already bound to another name.' },
    };
  }
  if (registrations.some((entry) => entry.canonicalName === valid.value.canonicalName)) {
    return {
      ok: false,
      error: { code: 'NAME_ALREADY_ACTIVE', message: 'Name is already active on another pane.' },
    };
  }
  return {
    ok: true,
    value: [
      ...registrations,
      { name: valid.value.name, canonicalName: valid.value.canonicalName, paneId },
    ],
  };
}

export function unbindGlobalPane(
  registrations: readonly ActiveRegistration[],
  paneId: string
): BindingResult<readonly ActiveRegistration[]> {
  if (!registrations.some((entry) => entry.paneId === paneId)) {
    return {
      ok: false,
      error: { code: 'UNBOUND_PANE', message: 'Pane has no active global name.' },
    };
  }
  return { ok: true, value: registrations.filter((entry) => entry.paneId !== paneId) };
}

export { normalizeName, validateName };
