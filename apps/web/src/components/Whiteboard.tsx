import { useEffect, useRef, useState } from 'react';
import { Eraser, Pen, Trash2, X } from 'lucide-react';
import { Permission, ulid } from '@tavern/shared';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';
import { useCanIn } from '../lib/store.js';
import { onWhiteboardClear, onWhiteboardStroke } from '../lib/voice-events.js';

type Tool = 'pen' | 'eraser';

interface Stroke {
  id: string;
  points: Array<[number, number]>;
  color: string;
  width: number;
  kind: Tool;
}

interface WhiteboardState {
  channelId: string;
  strokes: Stroke[];
  updatedBy: string | null;
  updatedAt: string | null;
}

interface Props {
  channelId: string;
  serverId: string;
  onClose: () => void;
}

const COLORS = ['#1f1d1b', '#c0392b', '#27ae60', '#2c6fd1', '#8e44ad', '#e8b03a'] as const;
const PEN_WIDTHS = [2, 4, 8] as const;
const DEFAULT_COLOR = COLORS[0];
const DEFAULT_WIDTH = PEN_WIDTHS[1];
const ERASER_WIDTH = 20;
const CANVAS_W = 760;
const CANVAS_H = 480;

/**
 * Wave 3 #34 — collaborative whiteboard.
 *
 * Each pen-up POSTs a single stroke to `/channels/:channelId/whiteboard/stroke`,
 * which the server appends + broadcasts as `WHITEBOARD_STROKE`. Remote
 * strokes arrive via the voice-events bus; the local canvas replays the
 * full ordered list on every redraw. No CRDT / OT — last-write-wins on the
 * server, but each stroke is a distinct object so concurrent users don't
 * collide. Clear is a separate route gated on `MANAGE_MESSAGES`.
 */
export function Whiteboard({ channelId, serverId, onClose }: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const drawingRef = useRef<Stroke | null>(null);
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState<string>(DEFAULT_COLOR);
  const [width, setWidth] = useState<number>(DEFAULT_WIDTH);
  const canClear = useCanIn(serverId, Permission.MANAGE_MESSAGES);

  function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke): void {
    const first = s.points[0];
    if (!first) return;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = s.width;
    ctx.strokeStyle = s.kind === 'eraser' ? '#ffffff' : s.color;
    ctx.globalCompositeOperation = s.kind === 'eraser' ? 'destination-out' : 'source-over';
    ctx.beginPath();
    ctx.moveTo(first[0], first[1]);
    for (let i = 1; i < s.points.length; i++) {
      const pt = s.points[i];
      if (!pt) continue;
      ctx.lineTo(pt[0], pt[1]);
    }
    ctx.stroke();
    // Reset composite so subsequent strokes use the default source-over.
    ctx.globalCompositeOperation = 'source-over';
  }

  function redraw(): void {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of strokesRef.current) drawStroke(ctx, s);
    if (drawingRef.current) drawStroke(ctx, drawingRef.current);
  }

  // Hydrate from server on mount.
  useEffect(() => {
    let cancelled = false;
    void api<WhiteboardState>(`/channels/${channelId}/whiteboard`)
      .then((res) => {
        if (cancelled) return;
        strokesRef.current = Array.isArray(res.strokes) ? res.strokes : [];
        redraw();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [channelId]);

  // Subscribe to remote strokes + clears.
  useEffect(() => {
    const offStroke = onWhiteboardStroke((p) => {
      if (p.channelId !== channelId) return;
      strokesRef.current = [...strokesRef.current, p.stroke as Stroke];
      redraw();
    });
    const offClear = onWhiteboardClear((p) => {
      if (p.channelId !== channelId) return;
      strokesRef.current = [];
      redraw();
    });
    return () => {
      offStroke();
      offClear();
    };
  }, [channelId]);

  function pointerDown(e: React.PointerEvent<HTMLCanvasElement>): void {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    drawingRef.current = {
      id: ulid(),
      points: [[(e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY]],
      color,
      width: tool === 'eraser' ? ERASER_WIDTH : width,
      kind: tool,
    };
  }

  function pointerMove(e: React.PointerEvent<HTMLCanvasElement>): void {
    const drawing = drawingRef.current;
    if (!drawing) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    drawing.points.push([(e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY]);
    redraw();
  }

  async function pointerUp(): Promise<void> {
    const drawing = drawingRef.current;
    if (!drawing) return;
    drawingRef.current = null;
    // Single-tap → duplicate the point so the line has visible length.
    if (drawing.points.length < 2) {
      const first = drawing.points[0];
      if (first) drawing.points.push([first[0], first[1]]);
    }
    strokesRef.current = [...strokesRef.current, drawing];
    redraw();
    try {
      await api(`/channels/${channelId}/whiteboard/stroke`, {
        method: 'POST',
        body: { stroke: drawing },
      });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save stroke');
    }
  }

  async function clearAll(): Promise<void> {
    if (!window.confirm('Clear the whiteboard for everyone?')) return;
    try {
      await api(`/channels/${channelId}/whiteboard`, { method: 'DELETE' });
      strokesRef.current = [];
      redraw();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not clear');
    }
  }

  return (
    <section className="absolute inset-x-0 bottom-full z-30 mb-2 max-h-[80vh] w-[min(95vw,800px)] overflow-y-auto rounded border border-subtle bg-surface p-3 shadow-lg">
      <header className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="font-serif text-sm">Whiteboard</h2>
        <div className="ml-2 flex items-center gap-1">
          <button
            type="button"
            className={tool === 'pen' ? 'btn-primary' : 'btn-ghost'}
            onClick={() => setTool('pen')}
            aria-pressed={tool === 'pen'}
            title="Pen"
          >
            <Pen size={14} />
          </button>
          <button
            type="button"
            className={tool === 'eraser' ? 'btn-primary' : 'btn-ghost'}
            onClick={() => setTool('eraser')}
            aria-pressed={tool === 'eraser'}
            title="Eraser"
          >
            <Eraser size={14} />
          </button>
        </div>
        {tool === 'pen' ? (
          <>
            <div className="flex gap-1">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={`h-6 w-6 rounded-full border ${color === c ? 'border-ember' : 'border-subtle'}`}
                  style={{ backgroundColor: c }}
                  aria-label={`Color ${c}`}
                />
              ))}
            </div>
            <div className="flex gap-1">
              {PEN_WIDTHS.map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => setWidth(w)}
                  className={`grid h-7 w-7 place-items-center rounded ${
                    width === w ? 'bg-tint-ember' : 'hover:bg-raised'
                  }`}
                  aria-label={`Width ${w}`}
                >
                  <span
                    className="rounded-full bg-fg"
                    style={{ width: w, height: w }}
                  />
                </button>
              ))}
            </div>
          </>
        ) : null}
        {canClear ? (
          <button
            type="button"
            className="btn-ghost ml-auto"
            onClick={() => void clearAll()}
            title="Clear whiteboard"
          >
            <Trash2 size={14} />
          </button>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          className={`rounded p-1 hover:bg-raised ${canClear ? '' : 'ml-auto'}`}
          aria-label="Close"
        >
          <X size={14} />
        </button>
      </header>
      <canvas
        ref={canvasRef}
        width={CANVAS_W}
        height={CANVAS_H}
        className="block w-full touch-none rounded border border-subtle bg-canvas"
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={() => void pointerUp()}
        onPointerLeave={() => void pointerUp()}
      />
    </section>
  );
}
