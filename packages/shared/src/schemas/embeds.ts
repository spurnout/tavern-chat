import { z } from 'zod';

/**
 * Rich embeds + interactive message components (parity gap #2).
 *
 * Embeds are render-only structured cards (primarily for webhooks / slash /
 * system messages). Components are action rows of buttons + select menus; a
 * press hits the interactions endpoint. Both are stored as jsonb on Message.
 */

export const EMBED_LIMITS = {
  MAX_EMBEDS: 10,
  MAX_FIELDS: 25,
  MAX_DESCRIPTION: 4096,
  MAX_TITLE: 256,
  MAX_FIELD_VALUE: 1024,
  MAX_FOOTER: 2048,
  MAX_ROWS: 5,
  MAX_COMPONENTS_PER_ROW: 5,
  MAX_SELECT_OPTIONS: 25,
  MAX_LABEL: 80,
  MAX_CUSTOM_ID: 100,
} as const;

const httpUrl = z.string().url().max(2048);

export const embedAuthorSchema = z.object({
  name: z.string().max(EMBED_LIMITS.MAX_TITLE),
  url: httpUrl.optional(),
  iconUrl: httpUrl.optional(),
});

export const embedFieldSchema = z.object({
  name: z.string().max(EMBED_LIMITS.MAX_TITLE),
  value: z.string().max(EMBED_LIMITS.MAX_FIELD_VALUE),
  inline: z.boolean().default(false),
});

export const embedFooterSchema = z.object({
  text: z.string().max(EMBED_LIMITS.MAX_FOOTER),
  iconUrl: httpUrl.optional(),
});

export const messageEmbedSchema = z.object({
  title: z.string().max(EMBED_LIMITS.MAX_TITLE).optional(),
  description: z.string().max(EMBED_LIMITS.MAX_DESCRIPTION).optional(),
  url: httpUrl.optional(),
  /** 24-bit RGB integer (0..0xFFFFFF). */
  color: z.number().int().min(0).max(0xffffff).optional(),
  author: embedAuthorSchema.optional(),
  fields: z.array(embedFieldSchema).max(EMBED_LIMITS.MAX_FIELDS).default([]),
  image: z.object({ url: httpUrl }).optional(),
  footer: embedFooterSchema.optional(),
  timestamp: z.string().datetime().optional(),
});

export const buttonComponentSchema = z
  .object({
    type: z.literal('button'),
    style: z.enum(['primary', 'secondary', 'success', 'danger', 'link']),
    label: z.string().min(1).max(EMBED_LIMITS.MAX_LABEL),
    customId: z.string().max(EMBED_LIMITS.MAX_CUSTOM_ID).optional(),
    url: httpUrl.optional(),
    disabled: z.boolean().default(false),
  })
  .superRefine((data, ctx) => {
    // Link buttons carry a url and no customId; all others carry a customId and
    // no url. (Mirrors the createMessageRequestSchema superRefine idiom.)
    if (data.style === 'link') {
      if (!data.url) {
        ctx.addIssue({ code: 'custom', message: 'Link buttons need a url', path: ['url'] });
      }
      if (data.customId) {
        ctx.addIssue({ code: 'custom', message: 'Link buttons cannot have a customId', path: ['customId'] });
      }
    } else {
      if (!data.customId) {
        ctx.addIssue({ code: 'custom', message: 'Buttons need a customId', path: ['customId'] });
      }
      if (data.url) {
        ctx.addIssue({ code: 'custom', message: 'Only link buttons carry a url', path: ['url'] });
      }
    }
  });

export const selectOptionSchema = z.object({
  label: z.string().min(1).max(EMBED_LIMITS.MAX_LABEL),
  value: z.string().min(1).max(EMBED_LIMITS.MAX_CUSTOM_ID),
  description: z.string().max(EMBED_LIMITS.MAX_FIELD_VALUE).optional(),
});

export const selectComponentSchema = z.object({
  type: z.literal('select'),
  customId: z.string().min(1).max(EMBED_LIMITS.MAX_CUSTOM_ID),
  placeholder: z.string().max(EMBED_LIMITS.MAX_LABEL).optional(),
  minValues: z.number().int().min(0).max(EMBED_LIMITS.MAX_SELECT_OPTIONS).default(1),
  maxValues: z.number().int().min(1).max(EMBED_LIMITS.MAX_SELECT_OPTIONS).default(1),
  options: z.array(selectOptionSchema).min(1).max(EMBED_LIMITS.MAX_SELECT_OPTIONS),
});

export const actionRowSchema = z.object({
  components: z
    .array(z.union([buttonComponentSchema, selectComponentSchema]))
    .min(1)
    .max(EMBED_LIMITS.MAX_COMPONENTS_PER_ROW),
});

export const messageEmbedsSchema = z.array(messageEmbedSchema).max(EMBED_LIMITS.MAX_EMBEDS);
export const messageComponentsSchema = z.array(actionRowSchema).max(EMBED_LIMITS.MAX_ROWS);

/** Body of POST /api/messages/:id/interactions. */
export const interactionExecuteSchema = z.object({
  customId: z.string().min(1).max(EMBED_LIMITS.MAX_CUSTOM_ID),
  values: z.array(z.string().max(EMBED_LIMITS.MAX_CUSTOM_ID)).max(EMBED_LIMITS.MAX_SELECT_OPTIONS).default([]),
});

export type MessageEmbed = z.infer<typeof messageEmbedSchema>;
export type ButtonComponent = z.infer<typeof buttonComponentSchema>;
export type SelectComponent = z.infer<typeof selectComponentSchema>;
export type ActionRow = z.infer<typeof actionRowSchema>;
export type InteractionExecuteRequest = z.infer<typeof interactionExecuteSchema>;
