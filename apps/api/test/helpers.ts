/**
 * Test helpers — in particular, an in-memory stub of the small slice of the
 * Prisma client the auth flows actually use. We don't try to be a full DB
 * emulator; we implement just enough surface to exercise the auth paths
 * deterministically without docker.
 *
 * Real integration tests against Postgres live separately (Phase 1+) and run
 * against the docker-compose stack.
 */

export interface UserRow {
  id: string;
  username: string;
  usernameLower: string;
  displayName: string;
  email: string;
  emailLower: string;
  passwordHash: string;
  isInstanceAdmin: boolean;
  avatarAttachmentId: string | null;
  bio: string | null;
  postingLockedUntil: Date | null;
  uploadsLockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionRow {
  id: string;
  userId: string;
  refreshTokenHash: string;
  deviceName: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface InviteRow {
  id: string;
  code: string;
  scope: 'instance' | 'server';
  serverId: string | null;
  channelId: string | null;
  createdById: string | null;
  maxUses: number | null;
  uses: number;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface FakeDb {
  users: Map<string, UserRow>;
  sessions: Map<string, SessionRow>;
  invites: Map<string, InviteRow>;
}

export function makeFakeDb(): FakeDb {
  return {
    users: new Map(),
    sessions: new Map(),
    invites: new Map(),
  };
}

export function makeFakePrismaClient(db: FakeDb) {
  return {
    user: {
      async findUnique({ where, select }: { where: { id?: string; email?: string }; select?: Record<string, boolean> }) {
        let row: UserRow | undefined;
        if (where.id) row = db.users.get(where.id);
        else if (where.email) {
          for (const u of db.users.values()) {
            if (u.email === where.email) {
              row = u;
              break;
            }
          }
        }
        if (!row) return null;
        return projectRow(row, select);
      },
      async findFirst({
        where,
        select,
      }: {
        where: { OR?: Array<Record<string, unknown>>; usernameLower?: string; emailLower?: string };
        select?: Record<string, boolean>;
      }) {
        const matches = (u: UserRow): boolean => {
          if (!where) return true;
          if (where.OR) {
            return where.OR.some((cond) => matchesCondition(u as unknown as Record<string, unknown>, cond));
          }
          return matchesCondition(u as unknown as Record<string, unknown>, where);
        };
        for (const u of db.users.values()) {
          if (matches(u)) return projectRow(u, select);
        }
        return null;
      },
      async create({ data }: { data: Partial<UserRow> & { id: string; passwordHash: string } }) {
        const now = new Date();
        const row: UserRow = {
          id: data.id,
          username: data.username ?? '',
          usernameLower: data.usernameLower ?? '',
          displayName: data.displayName ?? '',
          email: data.email ?? '',
          emailLower: data.emailLower ?? '',
          passwordHash: data.passwordHash,
          isInstanceAdmin: data.isInstanceAdmin ?? false,
          avatarAttachmentId: data.avatarAttachmentId ?? null,
          bio: data.bio ?? null,
          postingLockedUntil: data.postingLockedUntil ?? null,
          uploadsLockedUntil: data.uploadsLockedUntil ?? null,
          createdAt: now,
          updatedAt: now,
        };
        db.users.set(row.id, row);
        return row;
      },
    },
    session: {
      async findUnique({ where }: { where: { id: string } }) {
        return db.sessions.get(where.id) ?? null;
      },
      async create({ data }: { data: Omit<SessionRow, 'createdAt' | 'revokedAt'> & { revokedAt?: Date | null } }) {
        const row: SessionRow = {
          ...data,
          revokedAt: data.revokedAt ?? null,
          createdAt: new Date(),
        };
        db.sessions.set(row.id, row);
        return row;
      },
      async update({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<SessionRow>;
      }) {
        const existing = db.sessions.get(where.id);
        if (!existing) throw new Error('Session not found');
        const updated = { ...existing, ...data };
        db.sessions.set(existing.id, updated);
        return updated;
      },
      async updateMany({
        where,
        data,
      }: {
        where: { userId: string; revokedAt: null };
        data: Partial<SessionRow>;
      }) {
        let count = 0;
        for (const s of db.sessions.values()) {
          if (s.userId === where.userId && s.revokedAt === null) {
            db.sessions.set(s.id, { ...s, ...data });
            count++;
          }
        }
        return { count };
      },
    },
    invite: {
      async findUnique({ where }: { where: { code: string } }) {
        for (const i of db.invites.values()) {
          if (i.code === where.code) return i;
        }
        return null;
      },
      async update({ where, data }: { where: { id: string }; data: { uses?: { increment: number } } }) {
        const existing = db.invites.get(where.id);
        if (!existing) throw new Error('Invite not found');
        const updated: InviteRow = {
          ...existing,
          uses: data.uses?.increment ? existing.uses + data.uses.increment : existing.uses,
        };
        db.invites.set(existing.id, updated);
        return updated;
      },
    },
    async $transaction<T>(fn: (tx: ReturnType<typeof makeFakePrismaClient>) => Promise<T>): Promise<T> {
      // No isolation: tests don't need it.
      return fn(this as unknown as ReturnType<typeof makeFakePrismaClient>);
    },
  };
}

function matchesCondition(row: Record<string, unknown>, cond: Record<string, unknown>): boolean {
  return Object.entries(cond).every(([k, v]) => row[k] === v);
}

function projectRow<T extends Record<string, unknown>>(row: T, select?: Record<string, boolean>): T {
  if (!select) return row;
  const out: Record<string, unknown> = {};
  for (const [k, want] of Object.entries(select)) {
    if (want) out[k] = row[k];
  }
  return out as T;
}
