/**
 * Wave 3 #14 — local NPC generator.
 *
 * Deterministic, no AI dependency. Picks a name, race, occupation, quirk,
 * appearance trait, voice trait, and adventure hook from weighted tables.
 * Operators with their own region/setting can override the lists via the
 * `seed` argument (a future enhancement; not wired into the route yet).
 */

export interface GeneratedNpc {
  name: string;
  race: string;
  occupation: string;
  quirk: string;
  appearance: string;
  voice: string;
  hook: string;
}

interface Table {
  weight: number;
  value: string;
}

function pick<T extends string>(rng: () => number, table: Table[]): T {
  const total = table.reduce((s, t) => s + t.weight, 0);
  let n = rng() * total;
  for (const t of table) {
    n -= t.weight;
    if (n <= 0) return t.value as T;
  }
  return table[table.length - 1]!.value as T;
}

const FIRST_NAMES: Table[] = [
  { weight: 3, value: 'Aldric' },
  { weight: 3, value: 'Brenna' },
  { weight: 3, value: 'Cassian' },
  { weight: 3, value: 'Dorra' },
  { weight: 3, value: 'Elwynn' },
  { weight: 3, value: 'Faelar' },
  { weight: 3, value: 'Garrick' },
  { weight: 3, value: 'Hesper' },
  { weight: 3, value: 'Iris' },
  { weight: 3, value: 'Jorvik' },
  { weight: 3, value: 'Kestrel' },
  { weight: 3, value: 'Lirien' },
  { weight: 3, value: 'Morwen' },
  { weight: 3, value: 'Niamh' },
  { weight: 3, value: 'Osric' },
  { weight: 3, value: 'Petra' },
  { weight: 3, value: 'Quill' },
  { weight: 3, value: 'Rowan' },
  { weight: 3, value: 'Saoirse' },
  { weight: 3, value: 'Thane' },
];

const SURNAMES: Table[] = [
  { weight: 2, value: 'Ashwood' },
  { weight: 2, value: 'Brightwater' },
  { weight: 2, value: 'Crowfoot' },
  { weight: 2, value: 'Dunhollow' },
  { weight: 2, value: 'Emberlock' },
  { weight: 2, value: 'Fenwick' },
  { weight: 2, value: 'Greybarrow' },
  { weight: 2, value: 'Hawkridge' },
  { weight: 2, value: 'Ironvale' },
  { weight: 2, value: 'Jorgensson' },
  { weight: 2, value: 'Kettleworth' },
  { weight: 2, value: 'Larkspur' },
  { weight: 2, value: 'Mistwind' },
  { weight: 2, value: 'Northstar' },
  { weight: 2, value: 'Ostgaard' },
];

const RACES: Table[] = [
  { weight: 5, value: 'human' },
  { weight: 3, value: 'half-elf' },
  { weight: 3, value: 'dwarf' },
  { weight: 3, value: 'halfling' },
  { weight: 2, value: 'elf' },
  { weight: 2, value: 'tiefling' },
  { weight: 2, value: 'half-orc' },
  { weight: 1, value: 'gnome' },
  { weight: 1, value: 'dragonborn' },
];

const OCCUPATIONS: Table[] = [
  { weight: 3, value: 'innkeeper' },
  { weight: 3, value: 'blacksmith' },
  { weight: 3, value: 'farmer' },
  { weight: 3, value: 'priest' },
  { weight: 3, value: 'merchant' },
  { weight: 2, value: 'sellsword' },
  { weight: 2, value: 'scribe' },
  { weight: 2, value: 'fishmonger' },
  { weight: 2, value: 'guard captain' },
  { weight: 2, value: 'apothecary' },
  { weight: 2, value: 'bard' },
  { weight: 2, value: 'cartographer' },
  { weight: 1, value: 'spy' },
  { weight: 1, value: 'ratcatcher' },
  { weight: 1, value: 'undertaker' },
  { weight: 1, value: 'wizard' },
];

const QUIRKS: Table[] = [
  { weight: 1, value: 'taps a copper coin against the table when thinking' },
  { weight: 1, value: 'refuses to make eye contact' },
  { weight: 1, value: 'punctuates every sentence with a proverb' },
  { weight: 1, value: 'carries a caged songbird everywhere' },
  { weight: 1, value: 'speaks in the third person' },
  { weight: 1, value: 'collects unusual buttons' },
  { weight: 1, value: 'is terrified of dogs' },
  { weight: 1, value: 'always wears mismatched gloves' },
  { weight: 1, value: 'hums an old lullaby under their breath' },
  { weight: 1, value: 'never sits with their back to a door' },
];

const APPEARANCE: Table[] = [
  { weight: 1, value: 'a scar across the left brow' },
  { weight: 1, value: 'unusually long fingers' },
  { weight: 1, value: 'flame-red hair, going to grey at the temples' },
  { weight: 1, value: 'one bright green eye, one cloudy' },
  { weight: 1, value: 'a faded sailor’s tattoo on the forearm' },
  { weight: 1, value: 'silver rings on every finger' },
  { weight: 1, value: 'a perpetually sunburned face' },
  { weight: 1, value: 'a missing earlobe' },
  { weight: 1, value: 'thick spectacles held together with twine' },
];

const VOICE: Table[] = [
  { weight: 1, value: 'a slow, deliberate drawl' },
  { weight: 1, value: 'a rasp, like they’ve been shouting' },
  { weight: 1, value: 'clipped consonants and a coastal lilt' },
  { weight: 1, value: 'high and breathy' },
  { weight: 1, value: 'a measured baritone' },
  { weight: 1, value: 'whispered, even when calm' },
  { weight: 1, value: 'punctuated by short laughs' },
];

const HOOKS: Table[] = [
  { weight: 1, value: 'is the only one who knows where the old well leads' },
  { weight: 1, value: 'owes a dangerous favour to the Veiled Sister' },
  { weight: 1, value: 'has been having the same dream for forty-three nights' },
  { weight: 1, value: 'recently inherited a key that fits no lock in town' },
  { weight: 1, value: 'is searching for a sibling who vanished last winter' },
  { weight: 1, value: 'is secretly the keeper of an old smuggler’s ledger' },
  { weight: 1, value: 'has a contract for the players, if they’ll keep it quiet' },
  { weight: 1, value: 'can spell a name that hasn’t been spoken in years' },
];

export function generateNpc(seed?: number): GeneratedNpc {
  // Mulberry32 — small, deterministic when a seed is supplied.
  let s = (seed ?? Math.floor(Math.random() * 2 ** 31)) >>> 0;
  const rng = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    name: `${pick(rng, FIRST_NAMES)} ${pick(rng, SURNAMES)}`,
    race: pick(rng, RACES),
    occupation: pick(rng, OCCUPATIONS),
    quirk: pick(rng, QUIRKS),
    appearance: pick(rng, APPEARANCE),
    voice: pick(rng, VOICE),
    hook: pick(rng, HOOKS),
  };
}
