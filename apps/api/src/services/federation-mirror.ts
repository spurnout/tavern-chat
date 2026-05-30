/**
 * Federation Phase 4 — mirror Server/Channel/Member lifecycle helpers.
 *
 * When a local user accepts a federated invite (or, conversely, when this
 * instance is the home and learns a peer has accepted one), the receiving
 * peer ends up with a "mirror" projection of the origin server:
 *
 *   - a Server row with `originInstanceId` pointing at the home peer,
 *   - a synthetic `@everyone` Role + `defaultRoleId` so permission checks
 *     work the same way as for a local server (no special-case branches
 *     across the rest of the API),
 *   - one Channel per remote channel that's exposed via federation, also
 *     stamped with the same `originInstanceId`,
 *   - one ServerMember per remote member, each backed by a synthetic local
 *     User row (`User.remoteUserId` set) via `ensureUserForRemoteUser`.
 *
 * This module is the low-level building block. It does NOT publish anything
 * to the gateway broker — every helper takes a `tx` (Prisma transaction
 * client) so the caller controls the transactional boundary, and any
 * gateway broadcast happens AFTER the surrounding `$transaction` resolves
 * (otherwise clients can see events for rows that rolled back).
 *
 * Architecture: callers inject a `resolveRemoteUser(remoteUserId): RemoteUser`
 * callback. The callback's job is to look up the cached RemoteUser row, and
 * on cache miss fetch + upsert the profile from the home peer. The default
 * production implementation wraps `FederationProfileService.fetchRemoteProfile`;
 * tests can pass a stub. Keeping the dependency as a callback (rather than
 * having this module import the profile service directly) keeps the test
 * surface small and avoids a circular reference — `federation-profile.ts`
 * is a high-level orchestrator and this is the low-level lifecycle helper.
 *
 * What this module deliberately does NOT do:
 *   - Cascade-delete the synthetic owner User on teardown. The
 *     `User.remoteUserId @unique` constraint preserves idempotency if the
 *     same Tavern is later re-joined; orphan synthetic Users are cheap.
 *   - Publish `gatewayBroker.publish` calls. The caller does that
 *     post-commit. See `apps/api/src/services/federation-inbound.ts` for
 *     the pattern.
 *   - Verify signatures or peer status. Callers are expected to have
 *     already validated the inbound envelope.
 */

import { Prisma, type PrismaClient, type RemoteUser } from '@prisma/client';
import {
  PERMISSION_DEFAULT_EVERYONE,
  serializePermissions,
  ulid,
} from '@tavern/shared';
import { ensureUserForRemoteUser } from './remote-user-upsert.js';

/**
 * Callback used by the mirror helpers to resolve a qualified `alice@b.example`
 * id into a cached `RemoteUser` row. Implementations must either return the
 * cached row (preferred — the row is durable) or fetch + upsert the profile
 * from the home peer and return the fresh row. Throwing is acceptable when
 * the peer is unreachable, the host is unknown, or the response signature
 * doesn't verify — the surrounding transaction will roll back.
 */
export type ResolveRemoteUserFn = (
  remoteUserId: string,
  tx: Prisma.TransactionClient,
) => Promise<RemoteUser>;

export interface FederationMirrorServiceOptions {
  resolveRemoteUser: ResolveRemoteUserFn;
}

export interface CreateMirrorServerInput {
  tx: Prisma.TransactionClient;
  serverId: string;
  originInstanceId: string;
  ownerRemoteUserId: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
}

export interface CreateMirrorServerResult {
  serverId: string;
  everyoneRoleId: string;
  ownerLocalUserId: string;
}

export interface UpsertMirrorChannelInput {
  tx: Prisma.TransactionClient;
  serverId: string;
  originInstanceId: string;
  channelId: string;
  name: string;
  type: 'text' | 'forum';
  topic: string | null;
  position: number;
  federationMode: 'inherit' | 'force_on' | 'force_off';
  nsfw: boolean;
}

export interface UpdateMirrorServerInput {
  name?: string;
  description?: string | null;
  iconUrl?: string | null;
}

/**
 * Thrown when the caller tries to mirror a server id that already exists
 * locally. Callers should `findUnique` first and short-circuit if needed —
 * the duplicate signal is a hard error rather than a no-op because the
 * presence of an existing Server with the same id usually indicates a
 * protocol-level mistake (id collision across peers, or a stale join.member
 * envelope hitting after the mirror was already torn down + recreated).
 */
export class MirrorServerExistsError extends Error {
  constructor(serverId: string) {
    super(`mirror server ${serverId} already exists`);
    this.name = 'MirrorServerExistsError';
  }
}

export class FederationMirrorService {
  constructor(private readonly opts: FederationMirrorServiceOptions) {}

  /**
   * Create the Server/Role/Owner triplet for a brand-new mirror.
   *
   * Caller is expected to have already verified that no Server row with
   * `serverId` exists; if one does, this throws `MirrorServerExistsError`
   * rather than upserting. The synthetic owner User is materialised via
   * `ensureUserForRemoteUser`, which handles the cache hit + race recovery
   * paths transparently.
   */
  async createMirrorServer(
    input: CreateMirrorServerInput,
  ): Promise<CreateMirrorServerResult> {
    const { tx, serverId, originInstanceId, ownerRemoteUserId } = input;

    // Caller-contract guard: a hard error rather than an idempotent no-op.
    // See the MirrorServerExistsError docblock above for the rationale.
    const existing = await tx.server.findUnique({
      where: { id: serverId },
      select: { id: true },
    });
    if (existing) {
      throw new MirrorServerExistsError(serverId);
    }

    // Resolve the owner. The callback either hits the RemoteUser cache or
    // does a profile fetch + upsert; in either case it returns a RemoteUser
    // row that's safe to feed into ensureUserForRemoteUser.
    const ownerRemote = await this.opts.resolveRemoteUser(ownerRemoteUserId, tx);
    // ensureUserForRemoteUser is typed against PrismaClient, but at runtime
    // accepts a TransactionClient anywhere a Client is expected (see the
    // identical cast in federation-inbound.ts). Cast through unknown so the
    // call participates in this transaction.
    const ownerLocal = await ensureUserForRemoteUser(
      ownerRemote,
      tx as unknown as PrismaClient,
    );

    const everyoneRoleId = ulid();

    // Mirror the bootstrap path in auth-service.ts: Server row first, then
    // the synthetic @everyone Role, then `defaultRoleId` is set on the
    // Server with a follow-up update. The two-step set is necessary because
    // Role.serverId FK requires the Server to exist before we can insert
    // the Role, and Server.defaultRoleId FK requires the Role to exist
    // before we can set it. Both ordering constraints are enforced by the
    // schema.
    await tx.server.create({
      data: {
        id: serverId,
        ownerUserId: ownerLocal.id,
        name: input.name,
        description: input.description,
        // Mirrors hold no LOCAL icon attachment — the icon lives on the home.
        // We persist the home's public capability URL directly on `iconUrl`
        // (#23); the web renders it as an `<img>` exactly like a local icon.
        iconAttachmentId: null,
        iconUrl: input.iconUrl,
        // The mirror inherits the home's federation flag implicitly — the
        // home wouldn't have sent us this snapshot if federation were off.
        federationEnabled: true,
        originInstanceId,
      },
    });

    await tx.role.create({
      data: {
        id: everyoneRoleId,
        serverId,
        name: '@everyone',
        color: 0,
        position: 0,
        isEveryone: true,
        permissions: new Prisma.Decimal(
          serializePermissions(PERMISSION_DEFAULT_EVERYONE),
        ),
      },
    });

    await tx.server.update({
      where: { id: serverId },
      data: { defaultRoleId: everyoneRoleId },
    });

    // Owner is also a member. We don't assign the @everyone role explicitly
    // in ServerMemberRole — permission resolution treats the default role as
    // implicit for every member.
    await tx.serverMember.create({
      data: { serverId, userId: ownerLocal.id },
    });

    return {
      serverId,
      everyoneRoleId,
      ownerLocalUserId: ownerLocal.id,
    };
  }

  /**
   * Idempotent channel upsert keyed on `channelId`. Stamps `originInstanceId`
   * on the row so the channel can be reasoned about as a mirror without
   * joining through Server. Voice / category / campaign / session / stage
   * are rejected — mirrors only carry text + forum channels (everything
   * else is per-instance state).
   *
   * Does NOT broadcast on the gateway. Callers fire `gatewayBroker.publish`
   * AFTER the surrounding transaction commits.
   */
  async upsertMirrorChannel(input: UpsertMirrorChannelInput): Promise<void> {
    const { tx, serverId, originInstanceId, channelId } = input;

    if (input.type !== 'text' && input.type !== 'forum') {
      throw new Error(
        `mirror channels must be text or forum, got '${input.type as string}'`,
      );
    }

    await tx.channel.upsert({
      where: { id: channelId },
      create: {
        id: channelId,
        serverId,
        type: input.type,
        name: input.name,
        topic: input.topic,
        position: input.position,
        federationMode: input.federationMode,
        nsfw: input.nsfw,
        originInstanceId,
      },
      update: {
        // serverId, type, and originInstanceId are intentionally NOT
        // updated. Changing them mid-flight would indicate a protocol bug —
        // the channel is the same channel; mutations only touch the
        // user-visible fields.
        name: input.name,
        topic: input.topic,
        position: input.position,
        federationMode: input.federationMode,
        nsfw: input.nsfw,
      },
    });
  }

  /**
   * Patch the surface fields of an existing mirror Server. Any field left
   * `undefined` is preserved. `description` and `iconUrl` accept `null`
   * explicitly so callers can unset them.
   */
  async updateMirrorServer(
    tx: Prisma.TransactionClient,
    input: UpdateMirrorServerInput & { serverId: string },
  ): Promise<void> {
    const { serverId, name, description, iconUrl } = input;

    const data: Prisma.ServerUpdateInput = {};
    if (name !== undefined) data.name = name;
    if (description !== undefined) data.description = description;
    // #23 — the home's public icon URL is stored directly on the mirror row
    // (mirrors have no local attachment). `null` explicitly clears it.
    if (iconUrl !== undefined) data.iconUrl = iconUrl;

    if (Object.keys(data).length === 0) return;
    await tx.server.update({ where: { id: serverId }, data });
  }

  /**
   * Remove a mirror channel by id. No-op if the row doesn't exist (idempotent
   * — the home can retry a delete envelope after we've already removed the
   * row locally). Cascades on Channel deletion handle messages, overwrites,
   * etc. via the schema's onDelete: Cascade FKs.
   */
  async deleteMirrorChannel(
    tx: Prisma.TransactionClient,
    serverId: string,
    channelId: string,
  ): Promise<void> {
    // Guard on serverId so a peer can't accidentally instruct us to delete
    // a channel from a different server. Defence in depth — the inbound
    // dispatcher should already have verified the envelope's serverId
    // matches the mirror's origin.
    const row = await tx.channel.findUnique({
      where: { id: channelId },
      select: { id: true, serverId: true },
    });
    if (!row) return;
    if (row.serverId !== serverId) {
      throw new Error(
        `channel ${channelId} belongs to server ${row.serverId}, not ${serverId}`,
      );
    }
    await tx.channel.delete({ where: { id: channelId } });
  }

  /**
   * Materialise a new ServerMember on a mirror server. Returns the local
   * User id (synthesised by `ensureUserForRemoteUser`) so the caller can
   * fire `MEMBER_ADD` broadcasts with the right id. Idempotent — if the
   * member already exists, returns the existing local user id without
   * raising.
   */
  async addMirrorMember(
    tx: Prisma.TransactionClient,
    serverId: string,
    joinerRemoteUserId: string,
    _displayName: string,
  ): Promise<string> {
    // `_displayName` is kept on the signature for parity with the envelope
    // schema (memberAddPayloadSchema.memberDisplayName). The RemoteUser
    // cache row already carries `displayNameCache`, so we don't need to
    // pass the name through ensureUserForRemoteUser — the cache row wins.
    void _displayName;

    const remoteUser = await this.opts.resolveRemoteUser(joinerRemoteUserId, tx);
    const localUser = await ensureUserForRemoteUser(
      remoteUser,
      tx as unknown as PrismaClient,
    );

    // Check for an existing membership BEFORE attempting the insert.
    // The previous approach (try/catch P2002) is unsafe inside a Postgres
    // interactive transaction: a failed INSERT aborts the transaction and
    // every subsequent statement fails with error 25P02.  Catching the
    // P2002 in JS does NOT recover the Postgres transaction state.
    // Using findUnique first is safe because inside an interactive
    // transaction there is no concurrent modification risk — callers run
    // these steps serially within the same $transaction callback.
    const existing = await tx.serverMember.findUnique({
      where: { serverId_userId: { serverId, userId: localUser.id } },
      select: { userId: true },
    });
    if (existing) return localUser.id;

    await tx.serverMember.create({
      data: { serverId, userId: localUser.id },
    });

    return localUser.id;
  }

  /**
   * Remove a mirror member by qualified remote id. No-op if the member
   * isn't present (idempotent — the home can retry leave envelopes).
   */
  async removeMirrorMember(
    tx: Prisma.TransactionClient,
    serverId: string,
    leaverRemoteUserId: string,
  ): Promise<void> {
    // Look up the local mirror of the remote user. If the User row doesn't
    // exist, the member can't be present either — treat as no-op.
    const user = await tx.user.findUnique({
      where: { remoteUserId: leaverRemoteUserId },
      select: { id: true },
    });
    if (!user) return;

    try {
      await tx.serverMember.delete({
        where: { serverId_userId: { serverId, userId: user.id } },
      });
    } catch (err) {
      // P2025 = "Record to delete does not exist". Idempotent — matches the
      // local DELETE handler's blanket try/catch.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        return;
      }
      throw err;
    }
  }

  /**
   * Tear down a mirror Server when no LOCAL members remain. "Local" =
   * `User.remoteInstanceId IS NULL` — remote users still on the mirror
   * (e.g. the home's own owner) don't keep it alive, because if no LOCAL
   * user is in the mirror there's no one on this instance who can see it.
   *
   * Returns `true` if teardown happened, `false` if at least one local
   * member is still present (the mirror stays).
   *
   * What gets deleted:
   *   - all remaining ServerMember rows on the mirror (cascade on Server
   *     delete handles this, but we drop them explicitly for clarity),
   *   - the synthetic @everyone Role (cascade via Server.roles),
   *   - all Channels on the mirror (cascade via Server.channels),
   *   - the Server row itself.
   *
   * What is intentionally PRESERVED:
   *   - the synthetic owner User row. The `User.remoteUserId @unique`
   *     constraint preserves idempotency if the same Tavern is later
   *     re-joined. Orphan synthetic Users are cheap (~150 bytes each)
   *     and cascading them would force a multi-server scan on every
   *     teardown to avoid breaking other mirrors.
   *   - any synthetic User rows for previously-mirrored members. Same
   *     rationale.
   */
  async tearDownMirrorServerIfEmpty(
    tx: Prisma.TransactionClient,
    serverId: string,
  ): Promise<boolean> {
    // Count local members. `User.remoteInstanceId IS NULL` is the marker
    // for a local account; the synthetic-mirror Users are non-null.
    const localMemberCount = await tx.serverMember.count({
      where: {
        serverId,
        user: { remoteInstanceId: null },
      },
    });
    if (localMemberCount > 0) return false;

    // Confirm this is actually a mirror server. Refusing to tear down a
    // local Server is defence-in-depth — every legitimate caller has
    // already verified `originInstanceId != null`, but a buggy caller
    // could otherwise wipe a local server.
    const server = await tx.server.findUnique({
      where: { id: serverId },
      select: { originInstanceId: true },
    });
    if (!server) return false;
    if (server.originInstanceId === null) {
      throw new Error(
        `refusing to tear down local (non-mirror) server ${serverId}`,
      );
    }

    // Drop the server. Cascades handle Channel/Role/ServerMember rows via
    // the schema's onDelete: Cascade FKs.
    await tx.server.delete({ where: { id: serverId } });
    return true;
  }
}
