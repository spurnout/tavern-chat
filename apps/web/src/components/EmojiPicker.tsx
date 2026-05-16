import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';

/**
 * Lightweight emoji picker. No external data dependency — we ship a curated
 * set of ~250 commonly used emoji across 8 categories. The previous "quick
 * reactions" pattern in ReactionBar still works; this picker is the new
 * canonical entry point for both inserting emoji in the composer and
 * adding reactions.
 *
 * Custom server emoji aren't wired in yet — that's a follow-up that fetches
 * `/api/servers/:id/emojis` and adds a "Custom" tab. The structure here
 * accommodates that without refactor.
 */

interface EmojiEntry {
  char: string;
  name: string;
  keywords: string[];
}

const CATEGORIES: Array<{ label: string; emojis: EmojiEntry[] }> = [
  {
    label: 'Smileys',
    emojis: [
      { char: '😀', name: 'grinning', keywords: ['smile', 'happy'] },
      { char: '😃', name: 'grinning big', keywords: ['smile', 'happy'] },
      { char: '😄', name: 'grinning eyes', keywords: ['smile', 'happy'] },
      { char: '😁', name: 'beaming', keywords: ['grin'] },
      { char: '😂', name: 'tears of joy', keywords: ['lol', 'laugh'] },
      { char: '🤣', name: 'rolling laughing', keywords: ['lmao', 'rofl'] },
      { char: '😊', name: 'blushing', keywords: ['smile', 'happy'] },
      { char: '😇', name: 'innocent', keywords: ['halo', 'angel'] },
      { char: '🙂', name: 'slight smile', keywords: ['ok'] },
      { char: '😉', name: 'wink', keywords: ['flirt'] },
      { char: '😍', name: 'heart eyes', keywords: ['love'] },
      { char: '🥰', name: 'smiling hearts', keywords: ['love'] },
      { char: '😘', name: 'kiss', keywords: ['love'] },
      { char: '😜', name: 'wink tongue', keywords: ['playful'] },
      { char: '🤪', name: 'zany', keywords: ['silly'] },
      { char: '🤔', name: 'thinking', keywords: ['hmm', 'ponder'] },
      { char: '🙄', name: 'eye roll', keywords: ['annoyed'] },
      { char: '😏', name: 'smirking', keywords: ['smug'] },
      { char: '😬', name: 'grimacing', keywords: ['awkward', 'yikes'] },
      { char: '😴', name: 'sleeping', keywords: ['zzz', 'tired'] },
      { char: '🤐', name: 'zipper mouth', keywords: ['quiet', 'secret'] },
      { char: '😎', name: 'sunglasses', keywords: ['cool'] },
      { char: '🤓', name: 'nerd', keywords: ['glasses'] },
      { char: '🧐', name: 'monocle', keywords: ['inspect'] },
      { char: '😢', name: 'crying', keywords: ['sad'] },
      { char: '😭', name: 'sobbing', keywords: ['sad', 'cry'] },
      { char: '😠', name: 'angry', keywords: ['mad'] },
      { char: '🤯', name: 'mind blown', keywords: ['shocked'] },
      { char: '😱', name: 'screaming fear', keywords: ['shocked', 'scary'] },
      { char: '🤬', name: 'cursing', keywords: ['angry', 'swear'] },
    ],
  },
  {
    label: 'People',
    emojis: [
      { char: '👍', name: 'thumbs up', keywords: ['yes', 'good', 'like'] },
      { char: '👎', name: 'thumbs down', keywords: ['no', 'bad', 'dislike'] },
      { char: '👋', name: 'wave', keywords: ['hi', 'hello'] },
      { char: '🤚', name: 'raised back hand', keywords: ['stop'] },
      { char: '✋', name: 'raised hand', keywords: ['high five'] },
      { char: '👏', name: 'clap', keywords: ['applause'] },
      { char: '🙌', name: 'raising hands', keywords: ['celebrate'] },
      { char: '🤝', name: 'handshake', keywords: ['deal'] },
      { char: '🙏', name: 'pray', keywords: ['please', 'thanks'] },
      { char: '✌️', name: 'peace', keywords: ['victory'] },
      { char: '🤞', name: 'crossed fingers', keywords: ['luck', 'hope'] },
      { char: '🤘', name: 'rock on', keywords: ['horns'] },
      { char: '🤙', name: 'call me', keywords: ['shaka'] },
      { char: '👌', name: 'ok hand', keywords: ['perfect'] },
      { char: '👀', name: 'eyes', keywords: ['looking'] },
      { char: '👻', name: 'ghost', keywords: ['boo', 'spooky'] },
      { char: '💀', name: 'skull', keywords: ['death', 'dead'] },
      { char: '☠️', name: 'skull crossbones', keywords: ['poison'] },
      { char: '🧙', name: 'mage', keywords: ['wizard', 'magic'] },
      { char: '🧝', name: 'elf', keywords: ['ttrpg', 'fantasy'] },
      { char: '🧛', name: 'vampire', keywords: ['fantasy'] },
      { char: '🐉', name: 'dragon', keywords: ['ttrpg', 'fantasy'] },
      { char: '🧞', name: 'genie', keywords: ['wish'] },
    ],
  },
  {
    label: 'Nature',
    emojis: [
      { char: '🐶', name: 'dog', keywords: ['puppy'] },
      { char: '🐱', name: 'cat', keywords: ['kitten'] },
      { char: '🦊', name: 'fox', keywords: [] },
      { char: '🐺', name: 'wolf', keywords: [] },
      { char: '🦁', name: 'lion', keywords: [] },
      { char: '🐯', name: 'tiger', keywords: [] },
      { char: '🐻', name: 'bear', keywords: [] },
      { char: '🐼', name: 'panda', keywords: [] },
      { char: '🐨', name: 'koala', keywords: [] },
      { char: '🐸', name: 'frog', keywords: [] },
      { char: '🐙', name: 'octopus', keywords: [] },
      { char: '🦑', name: 'squid', keywords: [] },
      { char: '🦀', name: 'crab', keywords: [] },
      { char: '🦞', name: 'lobster', keywords: [] },
      { char: '🐢', name: 'turtle', keywords: [] },
      { char: '🌲', name: 'evergreen', keywords: ['tree'] },
      { char: '🌳', name: 'tree', keywords: [] },
      { char: '🌴', name: 'palm tree', keywords: [] },
      { char: '🌵', name: 'cactus', keywords: [] },
      { char: '🌷', name: 'tulip', keywords: ['flower'] },
      { char: '🌹', name: 'rose', keywords: ['flower'] },
      { char: '🌻', name: 'sunflower', keywords: [] },
      { char: '🍄', name: 'mushroom', keywords: [] },
      { char: '⭐', name: 'star', keywords: [] },
      { char: '🌟', name: 'glowing star', keywords: [] },
      { char: '🔥', name: 'fire', keywords: ['flame', 'hot'] },
      { char: '⚡', name: 'lightning', keywords: ['bolt'] },
      { char: '❄️', name: 'snowflake', keywords: ['cold'] },
      { char: '🌙', name: 'moon', keywords: ['night'] },
      { char: '☀️', name: 'sun', keywords: ['day'] },
    ],
  },
  {
    label: 'Food',
    emojis: [
      { char: '🍎', name: 'apple', keywords: [] },
      { char: '🍌', name: 'banana', keywords: [] },
      { char: '🍇', name: 'grapes', keywords: [] },
      { char: '🍑', name: 'peach', keywords: [] },
      { char: '🍓', name: 'strawberry', keywords: [] },
      { char: '🍒', name: 'cherries', keywords: [] },
      { char: '🥑', name: 'avocado', keywords: [] },
      { char: '🌽', name: 'corn', keywords: [] },
      { char: '🥕', name: 'carrot', keywords: [] },
      { char: '🥖', name: 'bread', keywords: ['baguette'] },
      { char: '🥨', name: 'pretzel', keywords: [] },
      { char: '🧀', name: 'cheese', keywords: [] },
      { char: '🍖', name: 'meat', keywords: ['drumstick'] },
      { char: '🍕', name: 'pizza', keywords: [] },
      { char: '🍔', name: 'burger', keywords: [] },
      { char: '🌮', name: 'taco', keywords: [] },
      { char: '🍣', name: 'sushi', keywords: [] },
      { char: '🍰', name: 'cake', keywords: [] },
      { char: '🍪', name: 'cookie', keywords: [] },
      { char: '🍩', name: 'donut', keywords: [] },
      { char: '☕', name: 'coffee', keywords: [] },
      { char: '🍺', name: 'beer', keywords: [] },
      { char: '🍷', name: 'wine', keywords: [] },
      { char: '🥃', name: 'whisky', keywords: ['glass'] },
      { char: '🍻', name: 'cheers', keywords: ['beers'] },
    ],
  },
  {
    label: 'Activities',
    emojis: [
      { char: '🎲', name: 'die', keywords: ['dice', 'roll', 'ttrpg'] },
      { char: '🎯', name: 'bullseye', keywords: ['target', 'dart'] },
      { char: '🎮', name: 'video game', keywords: ['controller'] },
      { char: '🕹️', name: 'joystick', keywords: ['arcade'] },
      { char: '🎬', name: 'clapper board', keywords: ['action'] },
      { char: '🎵', name: 'musical note', keywords: ['music'] },
      { char: '🎉', name: 'party popper', keywords: ['celebrate', 'congrats'] },
      { char: '🏆', name: 'trophy', keywords: ['win'] },
      { char: '🥇', name: 'gold medal', keywords: ['first', 'win'] },
      { char: '🎁', name: 'gift', keywords: ['present'] },
      { char: '🎂', name: 'birthday cake', keywords: ['party'] },
      { char: '🃏', name: 'joker', keywords: ['card'] },
      { char: '🀄', name: 'mahjong', keywords: ['tile'] },
      { char: '🎴', name: 'flower card', keywords: [] },
      { char: '🎻', name: 'violin', keywords: ['fiddle'] },
      { char: '🎺', name: 'trumpet', keywords: ['horn'] },
      { char: '🎷', name: 'saxophone', keywords: [] },
      { char: '🥁', name: 'drum', keywords: [] },
    ],
  },
  {
    label: 'Travel',
    emojis: [
      { char: '🚗', name: 'car', keywords: [] },
      { char: '🚙', name: 'suv', keywords: [] },
      { char: '🚕', name: 'taxi', keywords: [] },
      { char: '🚌', name: 'bus', keywords: [] },
      { char: '🚲', name: 'bicycle', keywords: ['bike'] },
      { char: '🛵', name: 'scooter', keywords: [] },
      { char: '🚂', name: 'locomotive', keywords: ['train'] },
      { char: '✈️', name: 'airplane', keywords: ['plane'] },
      { char: '🚀', name: 'rocket', keywords: ['launch', 'ship'] },
      { char: '🚢', name: 'ship', keywords: ['boat'] },
      { char: '⛵', name: 'sailboat', keywords: [] },
      { char: '🏰', name: 'castle', keywords: ['fortress', 'tavern'] },
      { char: '🏯', name: 'castle 2', keywords: [] },
      { char: '⛺', name: 'tent', keywords: ['camp'] },
      { char: '🌋', name: 'volcano', keywords: [] },
      { char: '🗻', name: 'mountain', keywords: ['fuji'] },
    ],
  },
  {
    label: 'Objects',
    emojis: [
      { char: '⚔️', name: 'crossed swords', keywords: ['battle', 'fight'] },
      { char: '🛡️', name: 'shield', keywords: ['defense'] },
      { char: '🏹', name: 'bow and arrow', keywords: ['archer'] },
      { char: '🔮', name: 'crystal ball', keywords: ['magic', 'fortune'] },
      { char: '📜', name: 'scroll', keywords: ['parchment', 'rules'] },
      { char: '🗝️', name: 'old key', keywords: [] },
      { char: '🔑', name: 'key', keywords: [] },
      { char: '💰', name: 'money bag', keywords: ['gold'] },
      { char: '💎', name: 'gem', keywords: ['jewel'] },
      { char: '⚜️', name: 'fleur de lis', keywords: ['heraldry'] },
      { char: '🏺', name: 'amphora', keywords: ['urn'] },
      { char: '🪔', name: 'oil lamp', keywords: ['light'] },
      { char: '🕯️', name: 'candle', keywords: ['flame'] },
      { char: '🍯', name: 'honey pot', keywords: ['mead'] },
      { char: '📕', name: 'closed book', keywords: ['tome'] },
      { char: '📖', name: 'open book', keywords: ['reading'] },
      { char: '🗺️', name: 'map', keywords: ['adventure'] },
      { char: '🧭', name: 'compass', keywords: ['direction'] },
      { char: '🧪', name: 'test tube', keywords: ['potion'] },
      { char: '🧹', name: 'broom', keywords: [] },
    ],
  },
  {
    label: 'Symbols',
    emojis: [
      { char: '❤️', name: 'red heart', keywords: ['love'] },
      { char: '🧡', name: 'orange heart', keywords: [] },
      { char: '💛', name: 'yellow heart', keywords: [] },
      { char: '💚', name: 'green heart', keywords: [] },
      { char: '💙', name: 'blue heart', keywords: [] },
      { char: '💜', name: 'purple heart', keywords: [] },
      { char: '🖤', name: 'black heart', keywords: [] },
      { char: '🤍', name: 'white heart', keywords: [] },
      { char: '💔', name: 'broken heart', keywords: [] },
      { char: '✨', name: 'sparkles', keywords: ['shine'] },
      { char: '💯', name: '100', keywords: ['perfect'] },
      { char: '✅', name: 'check mark', keywords: ['done', 'yes'] },
      { char: '❌', name: 'cross', keywords: ['no', 'wrong'] },
      { char: '❓', name: 'question', keywords: [] },
      { char: '❗', name: 'exclamation', keywords: [] },
      { char: '⚠️', name: 'warning', keywords: [] },
    ],
  },
];

interface Props {
  open: boolean;
  onClose: () => void;
  onPick: (emoji: string) => void;
  /** Anchor — currently unused but reserved for future positioning logic. */
  anchorRef?: React.RefObject<HTMLElement>;
}

export function EmojiPicker({ open, onClose, onPick }: Props): JSX.Element | null {
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open, onClose]);

  const visible = useMemo(() => {
    if (!query.trim()) return CATEGORIES[activeCategory]?.emojis ?? [];
    const q = query.toLowerCase();
    const all: EmojiEntry[] = [];
    for (const c of CATEGORIES) {
      for (const e of c.emojis) {
        if (e.name.includes(q) || e.keywords.some((k) => k.includes(q))) {
          all.push(e);
        }
      }
    }
    return all;
  }, [query, activeCategory]);

  if (!open) return null;

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label="Emoji picker"
      className="z-50 w-80 rounded border border-subtle bg-surface shadow-lg"
    >
      <div className="border-b border-subtle p-2">
        <div className="flex items-center gap-2 rounded bg-canvas px-2 py-1">
          <Search size={14} className="text-fg-muted" />
          <input
            type="text"
            placeholder="Search emoji"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 bg-transparent text-sm outline-none"
            autoFocus
          />
        </div>
      </div>
      {!query.trim() ? (
        <div className="flex gap-1 border-b border-subtle px-2 py-1">
          {CATEGORIES.map((c, idx) => (
            <button
              key={c.label}
              type="button"
              onClick={() => setActiveCategory(idx)}
              className={`rounded px-2 py-1 text-xs ${
                idx === activeCategory ? 'bg-raised text-fg' : 'text-fg-muted hover:bg-raised'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="grid max-h-64 grid-cols-8 gap-1 overflow-y-auto p-2 text-xl">
        {visible.map((e) => (
          <button
            key={e.char}
            type="button"
            onClick={() => onPick(e.char)}
            title={e.name}
            className="rounded p-1 hover:bg-raised"
          >
            {e.char}
          </button>
        ))}
        {visible.length === 0 ? (
          <p className="col-span-8 px-2 py-4 text-center text-sm text-fg-muted">
            No emoji match “{query}”.
          </p>
        ) : null}
      </div>
    </div>
  );
}
