import { z } from 'zod';
import { idSchema } from './ids.js';

/**
 * A reaction emoji can be:
 *   - a unicode codepoint string (e.g. "👍")
 *   - a custom emoji reference of the form "custom:<emojiId>"
 */
export const reactionEmojiSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (value) => {
      if (value.startsWith('custom:')) {
        const id = value.slice('custom:'.length);
        return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id);
      }
      return true;
    },
    { message: 'Invalid custom emoji reference' },
  );

export const reactionSchema = z.object({
  messageId: idSchema,
  userId: idSchema,
  emoji: reactionEmojiSchema,
  createdAt: z.string().datetime(),
});

export const customEmojiSchema = z.object({
  id: idSchema,
  serverId: idSchema,
  name: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[a-z0-9_]+$/i, 'Letters, numbers, and underscore only'),
  attachmentId: idSchema,
  createdById: idSchema.nullable(),
  createdAt: z.string().datetime(),
});

export type ReactionEmoji = z.infer<typeof reactionEmojiSchema>;
export type Reaction = z.infer<typeof reactionSchema>;
export type CustomEmoji = z.infer<typeof customEmojiSchema>;
