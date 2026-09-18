import { useEffect, useRef, useState } from 'react';
import type { OfficeSlot } from './module-contract.js';
import { officeSlotKey } from './module-contract.js';
import { useAnchoredPanel } from './use-anchored-panel.js';
import type { PanelObstacles } from './use-anchored-panel.js';
import type { SelectionTarget } from '../rendering/selection-anchor.js';

export function OfficeExpansionForm({
  slots,
  selected,
  anchor,
  obstacles,
  busy,
  choose,
  create,
  cancel,
}: {
  slots: readonly OfficeSlot[];
  selected?: OfficeSlot;
  anchor?: SelectionTarget;
  obstacles?: PanelObstacles;
  busy: boolean;
  choose(slot: OfficeSlot): void;
  create(name: string): void;
  cancel(): void;
}) {
  const [name, setName] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const panel = useAnchoredPanel<HTMLFormElement>(anchor, obstacles);
  useEffect(() => {
    if (selected) input.current?.focus({ preventScroll: true });
  }, [selected]);
  return (
    <form
      ref={panel.ref}
      className="office-expansion-card"
      aria-label="New office"
      style={panel.style}
      onSubmit={(event) => {
        event.preventDefault();
        if (selected && !busy) create(name);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) {
          event.stopPropagation();
          cancel();
        }
      }}
    >
      <fieldset disabled={busy}>
        <details open={!selected}>
          <summary>
            <h2>
              New office
              <small>
                {selected
                  ? `Column ${selected.column}, row ${selected.row} · Change`
                  : 'Choose an office slot'}
              </small>
            </h2>
          </summary>
          <label>
            Office slot
            <select
              value={selected ? officeSlotKey(selected) : ''}
              onChange={(event) => {
                const slot = slots.find((slot) => officeSlotKey(slot) === event.target.value);
                if (slot) choose(slot);
              }}
            >
              <option value="" disabled>
                Choose a cyan preview
              </option>
              {slots.map((slot) => (
                <option key={officeSlotKey(slot)} value={officeSlotKey(slot)}>
                  Column {slot.column}, row {slot.row}
                </option>
              ))}
            </select>
          </label>
        </details>
        {selected ? (
          <label>
            Name
            <input
              ref={input}
              required
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        ) : (
          <p>
            {slots.length
              ? 'Select a whole office on the map, or choose its slot here.'
              : 'No adjacent office slots are available.'}
          </p>
        )}
        <div className="office-expansion-actions">
          <button type="button" aria-label="Cancel placement" onClick={cancel}>
            Cancel
          </button>
          <button type="submit" aria-label="Add office" disabled={!selected || !name.trim()}>
            Add
          </button>
        </div>
      </fieldset>
    </form>
  );
}
