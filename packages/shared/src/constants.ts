export const APP_NAME = 'Tavern';

export const MESSAGE_LIMITS = {
  MAX_CONTENT_LENGTH: 4000,
  MAX_ATTACHMENTS_PER_MESSAGE: 10,
  MAX_EMBEDS_PER_MESSAGE: 10,
  MAX_REACTIONS_PER_MESSAGE: 20,
} as const;

export const NAME_LIMITS = {
  MIN_USERNAME: 3,
  MAX_USERNAME: 32,
  MIN_DISPLAY_NAME: 1,
  MAX_DISPLAY_NAME: 64,
  MIN_PASSWORD: 8,
  MAX_PASSWORD: 256,
  MIN_SERVER_NAME: 2,
  MAX_SERVER_NAME: 64,
  MIN_CHANNEL_NAME: 1,
  MAX_CHANNEL_NAME: 64,
  MIN_ROLE_NAME: 1,
  MAX_ROLE_NAME: 64,
  MAX_TOPIC: 1024,
  MAX_DESCRIPTION: 2048,
} as const;

export const UPLOAD_LIMITS = {
  MAX_AVATAR_BYTES: 8 * 1024 * 1024,
  MAX_IMAGE_BYTES: 25 * 1024 * 1024,
  MAX_VIDEO_BYTES: 200 * 1024 * 1024,
  MAX_AUDIO_BYTES: 50 * 1024 * 1024,
  MAX_GENERIC_FILE_BYTES: 100 * 1024 * 1024,
  MAX_VOICE_MESSAGE_DURATION_MS: 5 * 60 * 1000,
} as const;

export const ALLOWED_IMAGE_MIMES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
] as const;

export const ALLOWED_VIDEO_MIMES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
] as const;

export const ALLOWED_AUDIO_MIMES = [
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/webm',
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
] as const;

export const BLOCKED_EXTENSIONS = [
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl',
  'js', 'vbs', 'vbe', 'wsf', 'wsh', 'jar',
  'app', 'dmg', 'pkg',
  'deb', 'rpm',
  'sh', 'bash', 'zsh', 'fish',
  'ps1', 'psm1',
  'apk', 'ipa',
  'lnk', 'url',
] as const;

export const BLOCKED_ARCHIVE_EXTENSIONS = [
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'cab',
] as const;

export const GATEWAY = {
  HEARTBEAT_INTERVAL_MS: 30_000,
  HEARTBEAT_TIMEOUT_MS: 45_000,
  IDENTIFY_TIMEOUT_MS: 10_000,
  MAX_PAYLOAD_BYTES: 1024 * 64,
} as const;

export const TOKEN_TTL = {
  ACCESS_SECONDS: 60 * 15,
  REFRESH_SECONDS: 60 * 60 * 24 * 30,
  INVITE_SECONDS: 60 * 60 * 24 * 7,
} as const;

export const DICE_LIMITS = {
  MAX_DICE_PER_ROLL: 100,
  MAX_FACES: 1000,
  MAX_NOTATION_LENGTH: 128,
} as const;
