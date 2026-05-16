import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';

/**
 * D&D 5e sheet renderer. Edits debounce-save back to the server. Fields
 * mirror the Zod schema in packages/shared/src/schemas/characters.ts —
 * stay aligned with that when adding new ones.
 */

interface AbilityScore {
  score: number;
  proficient: boolean;
}

interface Dnd5eSheet {
  level: number;
  className: string;
  race: string;
  background: string;
  alignment: string;
  experience: number;
  proficiencyBonus: number;
  inspiration: boolean;
  armorClass: number;
  initiativeBonus: number;
  speed: number;
  hitPoints: { current: number; max: number; temporary: number };
  hitDice: string;
  deathSaves: { successes: number; failures: number };
  abilities: Record<string, AbilityScore>;
  skills: Record<string, { proficient: boolean; expertise: boolean }>;
  inventory: Array<{ name: string; quantity: number; notes?: string }>;
  notes: string;
}

interface Character {
  id: string;
  campaignId: string;
  ownerUserId: string;
  name: string;
  conceptOneLiner: string | null;
  system: string;
  sheetJson: Dnd5eSheet;
}

const ABILITY_KEYS: Array<{ key: string; label: string }> = [
  { key: 'str', label: 'STR' },
  { key: 'dex', label: 'DEX' },
  { key: 'con', label: 'CON' },
  { key: 'int', label: 'INT' },
  { key: 'wis', label: 'WIS' },
  { key: 'cha', label: 'CHA' },
];

function modifier(score: number): string {
  const mod = Math.floor((score - 10) / 2);
  return mod >= 0 ? `+${mod}` : `${mod}`;
}

interface Props {
  character: Character;
  canEdit: boolean;
  onUpdated?: (c: Character) => void;
}

export function CharacterSheetDnD5e({ character, canEdit, onUpdated }: Props): JSX.Element {
  const [sheet, setSheet] = useState<Dnd5eSheet>(character.sheetJson);
  const [name, setName] = useState(character.name);
  const [concept, setConcept] = useState(character.conceptOneLiner ?? '');
  const [dirty, setDirty] = useState(false);

  // Reset when character switches.
  useEffect(() => {
    setSheet(character.sheetJson);
    setName(character.name);
    setConcept(character.conceptOneLiner ?? '');
    setDirty(false);
  }, [character.id]);

  // Debounced auto-save.
  useEffect(() => {
    if (!dirty || !canEdit) return;
    const t = setTimeout(() => {
      void save();
    }, 800);
    return () => clearTimeout(t);
  }, [dirty, sheet, name, concept]);

  async function save(): Promise<void> {
    try {
      const updated = await api<Character>(`/characters/${character.id}`, {
        method: 'PATCH',
        body: { name, conceptOneLiner: concept, sheetJson: sheet },
      });
      setDirty(false);
      onUpdated?.(updated);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save');
    }
  }

  function touch<T extends keyof Dnd5eSheet>(key: T, value: Dnd5eSheet[T]): void {
    setSheet((s) => ({ ...s, [key]: value }));
    setDirty(true);
  }

  function setAbility(key: string, patch: Partial<AbilityScore>): void {
    setSheet((s) => ({
      ...s,
      abilities: { ...s.abilities, [key]: { ...s.abilities[key]!, ...patch } },
    }));
    setDirty(true);
  }

  return (
    <div className="space-y-4">
      <div className="rounded border border-subtle bg-surface p-4">
        <input
          type="text"
          value={name}
          disabled={!canEdit}
          onChange={(e) => {
            setName(e.target.value);
            setDirty(true);
          }}
          className="input w-full text-lg font-serif"
        />
        <input
          type="text"
          value={concept}
          disabled={!canEdit}
          onChange={(e) => {
            setConcept(e.target.value);
            setDirty(true);
          }}
          placeholder="One-line concept"
          className="input mt-2 w-full text-sm"
        />
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <NumberField
            label="Level"
            value={sheet.level}
            min={1}
            max={30}
            disabled={!canEdit}
            onChange={(v) => touch('level', v)}
          />
          <TextField
            label="Class"
            value={sheet.className}
            disabled={!canEdit}
            onChange={(v) => touch('className', v)}
          />
          <TextField label="Race" value={sheet.race} disabled={!canEdit} onChange={(v) => touch('race', v)} />
          <TextField
            label="Background"
            value={sheet.background}
            disabled={!canEdit}
            onChange={(v) => touch('background', v)}
          />
        </div>
        <div className="mt-3 grid grid-cols-3 gap-3 text-sm md:grid-cols-5">
          <NumberField
            label="AC"
            value={sheet.armorClass}
            disabled={!canEdit}
            onChange={(v) => touch('armorClass', v)}
          />
          <NumberField
            label="Init"
            value={sheet.initiativeBonus}
            disabled={!canEdit}
            onChange={(v) => touch('initiativeBonus', v)}
          />
          <NumberField
            label="Speed"
            value={sheet.speed}
            disabled={!canEdit}
            onChange={(v) => touch('speed', v)}
          />
          <NumberField
            label="HP"
            value={sheet.hitPoints.current}
            disabled={!canEdit}
            onChange={(v) => touch('hitPoints', { ...sheet.hitPoints, current: v })}
          />
          <NumberField
            label="Max HP"
            value={sheet.hitPoints.max}
            disabled={!canEdit}
            onChange={(v) => touch('hitPoints', { ...sheet.hitPoints, max: v })}
          />
        </div>
      </div>

      <div className="rounded border border-subtle bg-surface p-4">
        <h3 className="font-serif text-sm">Abilities</h3>
        <div className="mt-2 grid grid-cols-3 gap-3 md:grid-cols-6">
          {ABILITY_KEYS.map((a) => {
            const score = sheet.abilities[a.key]?.score ?? 10;
            return (
              <div key={a.key} className="rounded border border-subtle bg-canvas p-2 text-center">
                <div className="text-xs font-mono text-fg-muted">{a.label}</div>
                <input
                  type="number"
                  value={score}
                  disabled={!canEdit}
                  min={1}
                  max={30}
                  onChange={(e) => setAbility(a.key, { score: Number(e.target.value) || 10 })}
                  className="input w-full text-center font-serif text-lg"
                />
                <div className="text-xs text-fg-muted">{modifier(score)}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="rounded border border-subtle bg-surface p-4">
        <h3 className="font-serif text-sm">Notes</h3>
        <textarea
          value={sheet.notes}
          disabled={!canEdit}
          onChange={(e) => touch('notes', e.target.value)}
          rows={6}
          className="input mt-2 w-full resize-y font-mono text-xs"
        />
      </div>

      <p className="text-xs text-fg-muted">
        {dirty ? 'Saving…' : 'All changes saved.'}
      </p>
    </div>
  );
}

function TextField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (v: string) => void;
}): JSX.Element {
  return (
    <label className="block">
      <span className="text-xs text-fg-muted">{label}</span>
      <input
        type="text"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="input mt-1 w-full"
      />
    </label>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}): JSX.Element {
  return (
    <label className="block">
      <span className="text-xs text-fg-muted">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        className="input mt-1 w-full font-mono"
      />
    </label>
  );
}
