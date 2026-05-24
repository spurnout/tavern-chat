/**
 * Wave 3 #12 — Sheet-aware roll macros.
 *
 * Expand template tokens like `{str_mod}` against a D&D 5e character sheet
 * before handing the notation to the dice parser. Unknown tokens raise an
 * error so a typo is obvious.
 *
 * Supported tokens (D&D 5e):
 *   {str_mod} {dex_mod} {con_mod} {int_mod} {wis_mod} {cha_mod}
 *   {str} {dex} ...                  raw ability scores
 *   {pb}                             proficiency bonus
 *   {level}                          character level
 *   {prof_skill:<name>}              prof bonus if the skill is proficient, else 0
 *
 * Generic system characters expose `{stats:<label>}` to read a value from
 * the generic stats array.
 */

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

interface AbilityScore {
  score: number;
  proficient: boolean;
}

interface Dnd5eSheet {
  level?: number;
  proficiencyBonus?: number;
  abilities?: Record<string, AbilityScore>;
  skills?: Record<string, { proficient: boolean; expertise: boolean }>;
}

interface GenericSheet {
  stats?: Array<{ label: string; value: string }>;
}

/** Local alias — the public `CharacterSystem` type lives in schemas/characters. */
type SystemKind = 'dnd5e' | 'pbta' | 'generic';

const TOKEN_RE = /\{([a-zA-Z0-9_:\- ]+)\}/g;

function abilityMod(score: number): number {
  return Math.floor((score - 10) / 2);
}

export function expandTemplate(
  notation: string,
  opts: { system: SystemKind; sheet: unknown },
): string {
  return notation.replace(TOKEN_RE, (_, raw) => {
    const token = String(raw).trim().toLowerCase();
    if (opts.system === 'dnd5e') {
      const sheet = (opts.sheet ?? {}) as Dnd5eSheet;
      const abilities = sheet.abilities ?? {};
      const pb = sheet.proficiencyBonus ?? 2;
      // {str_mod} ... {cha_mod}
      const modMatch = /^(str|dex|con|int|wis|cha)_mod$/.exec(token);
      if (modMatch) {
        const a = abilities[modMatch[1]!]?.score ?? 10;
        return formatSigned(abilityMod(a));
      }
      // {str} ... {cha}
      const rawMatch = /^(str|dex|con|int|wis|cha)$/.exec(token);
      if (rawMatch) {
        return String(abilities[rawMatch[1]!]?.score ?? 10);
      }
      if (token === 'pb' || token === 'prof') return formatSigned(pb);
      if (token === 'level') return String(sheet.level ?? 1);
      const skillMatch = /^prof_skill:(.+)$/.exec(token);
      if (skillMatch) {
        const key = skillMatch[1]!.trim();
        const skill = sheet.skills?.[key];
        return skill?.proficient ? formatSigned(pb) : '+0';
      }
    } else if (opts.system === 'generic') {
      const sheet = (opts.sheet ?? {}) as GenericSheet;
      const m = /^stats:(.+)$/.exec(token);
      if (m) {
        const label = m[1]!.trim().toLowerCase();
        const stat = sheet.stats?.find((s) => s.label.toLowerCase() === label);
        if (stat) {
          // SEC: generic stat values are user-controlled (free-text sheet
          // fields). A value like "1d6+1d6+..." or 200 chars of garbage
          // bypasses the dice parser's MAX_NOTATION_LENGTH (checked on the
          // pre-expansion template, not the post-expansion notation). Only
          // numbers and signed modifiers (`+3`, `-2`, `1d6 + 2`) are
          // meaningful inside dice notation; reject anything else with a
          // clear error rather than feed the parser content it can't
          // safely handle. Cap length at 32 chars for the value itself.
          const cleaned = stat.value.trim();
          if (cleaned.length > 32 || !/^[-+\sd0-9]+$/i.test(cleaned)) {
            throw new TemplateError(
              `Stat "${label}" is not a valid dice modifier`,
            );
          }
          return cleaned;
        }
      }
    }
    throw new TemplateError(`Unknown template token: {${raw}}`);
  });
}

function formatSigned(n: number): string {
  if (n >= 0) return `+${n}`;
  return `${n}`;
}
