import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ok } from '../lib/responses.js';

/**
 * Wave 3 #8 — SRD spell & ability compendium (minimal).
 *
 * This MVP ships a handful of representative entries so the UI surface is
 * end-to-end testable. A real implementation bundles the full D&D 5.1 SRD
 * (OGL / CC-BY 4.0) under `packages/data/src/srd/*.json` and serves it from
 * there with proper licensing notices.
 */

interface CompendiumSpell {
  kind: 'spell';
  id: string;
  name: string;
  level: number;
  school: string;
  castingTime: string;
  range: string;
  components: string;
  duration: string;
  description: string;
}

interface CompendiumMonster {
  kind: 'monster';
  id: string;
  name: string;
  size: string;
  type: string;
  alignment: string;
  ac: number;
  hp: number;
  speed: string;
  cr: string;
  description: string;
}

type CompendiumEntry = CompendiumSpell | CompendiumMonster;

const SPELLS: CompendiumSpell[] = [
  {
    kind: 'spell',
    id: 'spell:fireball',
    name: 'Fireball',
    level: 3,
    school: 'evocation',
    castingTime: '1 action',
    range: '150 feet',
    components: 'V, S, M (a tiny ball of bat guano and sulfur)',
    duration: 'Instantaneous',
    description:
      'A bright streak flashes from your pointing finger to a point you choose within range and then blossoms with a low roar into an explosion of flame. Each creature in a 20-foot-radius sphere centered on that point must make a Dexterity saving throw, taking 8d6 fire damage on a failed save, or half as much on a successful one.',
  },
  {
    kind: 'spell',
    id: 'spell:healing_word',
    name: 'Healing Word',
    level: 1,
    school: 'evocation',
    castingTime: '1 bonus action',
    range: '60 feet',
    components: 'V',
    duration: 'Instantaneous',
    description:
      'A creature of your choice that you can see within range regains hit points equal to 1d4 + your spellcasting ability modifier.',
  },
  {
    kind: 'spell',
    id: 'spell:shield',
    name: 'Shield',
    level: 1,
    school: 'abjuration',
    castingTime: '1 reaction',
    range: 'Self',
    components: 'V, S',
    duration: '1 round',
    description:
      'An invisible barrier of magical force appears and protects you. Until the start of your next turn, you have a +5 bonus to AC.',
  },
];

const MONSTERS: CompendiumMonster[] = [
  {
    kind: 'monster',
    id: 'monster:goblin',
    name: 'Goblin',
    size: 'Small',
    type: 'humanoid (goblinoid)',
    alignment: 'neutral evil',
    ac: 15,
    hp: 7,
    speed: '30 ft.',
    cr: '1/4',
    description:
      'Small, black-hearted humanoids that lair in caves, abandoned mines, and despoiled dungeons.',
  },
  {
    kind: 'monster',
    id: 'monster:owlbear',
    name: 'Owlbear',
    size: 'Large',
    type: 'monstrosity',
    alignment: 'unaligned',
    ac: 13,
    hp: 59,
    speed: '40 ft.',
    cr: '3',
    description:
      'A monstrous predator with the body of a bear and the head of a great owl. Owlbears live in forests of all sorts.',
  },
];

const ALL_ENTRIES: CompendiumEntry[] = [...SPELLS, ...MONSTERS];

export async function registerCompendiumRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/compendium', async (req, reply) => {
    const q = z
      .object({
        q: z.string().max(120).optional(),
        kind: z.enum(['spell', 'monster']).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(req.query);
    const needle = q.q?.toLowerCase().trim();
    const filtered = ALL_ENTRIES.filter((e) => {
      if (q.kind && e.kind !== q.kind) return false;
      if (!needle) return true;
      return (
        e.name.toLowerCase().includes(needle) ||
        e.description.toLowerCase().includes(needle) ||
        e.id.toLowerCase().includes(needle)
      );
    }).slice(0, q.limit);
    reply.send(ok({ items: filtered, total: filtered.length }));
  });

  app.get('/api/compendium/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const entry = ALL_ENTRIES.find((e) => e.id === id);
    if (!entry) {
      reply.status(404).send({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Entry not found' },
      });
      return;
    }
    reply.send(ok(entry));
  });
}
