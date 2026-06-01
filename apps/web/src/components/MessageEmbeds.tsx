import type { MessageEmbed } from '@tavern/shared';
import { MessageContent } from './MessageContent.js';

/** Render a message's rich embeds (parity gap #2). Read-only cards. */
export function MessageEmbeds({ embeds }: { embeds: MessageEmbed[] }): JSX.Element | null {
  if (embeds.length === 0) return null;
  return (
    <div className="mt-1 space-y-2">
      {embeds.map((e, i) => (
        <Embed key={i} embed={e} />
      ))}
    </div>
  );
}

function hex(color: number | undefined): string | undefined {
  if (color === undefined) return undefined;
  return `#${color.toString(16).padStart(6, '0')}`;
}

function Embed({ embed }: { embed: MessageEmbed }): JSX.Element {
  const bar = hex(embed.color);
  return (
    <div
      className="overflow-hidden rounded border border-subtle bg-surface p-3"
      style={bar ? { borderLeftColor: bar, borderLeftWidth: 3 } : undefined}
    >
      {embed.author ? (
        <div className="mb-1 flex items-center gap-1.5 text-xs text-fg-muted">
          {embed.author.iconUrl ? (
            <img src={embed.author.iconUrl} alt="" className="h-4 w-4 rounded-full" />
          ) : null}
          {embed.author.url ? (
            <a href={embed.author.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
              {embed.author.name}
            </a>
          ) : (
            <span>{embed.author.name}</span>
          )}
        </div>
      ) : null}

      {embed.title ? (
        <div className="font-serif font-medium">
          {embed.url ? (
            <a href={embed.url} target="_blank" rel="noopener noreferrer" className="text-ember hover:underline">
              {embed.title}
            </a>
          ) : (
            embed.title
          )}
        </div>
      ) : null}

      {embed.description ? (
        <div className="mt-1 text-sm">
          <MessageContent content={embed.description} />
        </div>
      ) : null}

      {embed.fields.length > 0 ? (
        <div className="mt-2 grid grid-cols-2 gap-2">
          {embed.fields.map((f, i) => (
            <div key={i} className={f.inline ? '' : 'col-span-2'}>
              <div className="text-xs font-medium text-fg">{f.name}</div>
              <div className="text-xs text-fg-muted">
                <MessageContent content={f.value} />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {embed.image ? (
        <img src={embed.image.url} alt="" className="mt-2 max-h-80 rounded" />
      ) : null}

      {embed.footer || embed.timestamp ? (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-fg-muted">
          {embed.footer?.iconUrl ? (
            <img src={embed.footer.iconUrl} alt="" className="h-3.5 w-3.5 rounded-full" />
          ) : null}
          {embed.footer ? <span>{embed.footer.text}</span> : null}
          {embed.footer && embed.timestamp ? <span aria-hidden>·</span> : null}
          {embed.timestamp ? <span>{new Date(embed.timestamp).toLocaleString()}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
