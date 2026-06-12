import { Feather } from '@expo/vector-icons';
import type { Channel, Message, Server } from '@tavern/shared/schemas';
import type { JSX } from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ListRenderItem,
} from 'react-native';
import { Button, EmptyState, ErrorBanner, Screen, StatusPill } from '@/components/ui';
import { useAuthStore } from '@/stores/auth-store';
import { useTavernStore } from '@/stores/tavern-store';
import { colors, radii, spacing, typography } from '@/theme/tokens';

const CHAT_ROOM_TYPES = new Set<Channel['type']>([
  'text',
  'forum',
  'campaign',
  'session',
  'board_game',
]);

export function TavernHomeScreen(): JSX.Element {
  const me = useAuthStore((state) => state.me);
  const logout = useAuthStore((state) => state.logout);
  const instanceInfo = useAuthStore((state) => state.instanceInfo);
  const activeServerId = useTavernStore((state) => state.activeServerId);
  const activeChannelId = useTavernStore((state) => state.activeChannelId);
  const serversById = useTavernStore((state) => state.serversById);
  const channelsByServer = useTavernStore((state) => state.channelsByServer);
  const messagesByChannel = useTavernStore((state) => state.messagesByChannel);
  const loadingServers = useTavernStore((state) => state.loadingServers);
  const loadingChannelsByServer = useTavernStore((state) => state.loadingChannelsByServer);
  const loadingMessagesByChannel = useTavernStore((state) => state.loadingMessagesByChannel);
  const gatewayStatus = useTavernStore((state) => state.gatewayStatus);
  const error = useTavernStore((state) => state.error);
  const startRealtime = useTavernStore((state) => state.startRealtime);
  const stopRealtime = useTavernStore((state) => state.stopRealtime);
  const loadServers = useTavernStore((state) => state.loadServers);
  const selectServer = useTavernStore((state) => state.selectServer);
  const selectChannel = useTavernStore((state) => state.selectChannel);
  const clearChannel = useTavernStore((state) => state.clearChannel);
  const sendMessage = useTavernStore((state) => state.sendMessage);
  const resetTavern = useTavernStore((state) => state.reset);

  const servers = useMemo(() => Object.values(serversById), [serversById]);
  const activeServer = activeServerId ? serversById[activeServerId] ?? null : null;
  const channels = useMemo(() => {
    if (!activeServerId) return [];
    return channelsByServer[activeServerId] ?? [];
  }, [activeServerId, channelsByServer]);
  const activeChannel = useMemo(() => {
    if (!activeChannelId) return null;
    return channels.find((channel) => channel.id === activeChannelId) ?? null;
  }, [activeChannelId, channels]);
  const messages = activeChannelId ? messagesByChannel[activeChannelId] ?? [] : [];

  useEffect(() => {
    startRealtime();
    void loadServers();
    return () => stopRealtime();
  }, [loadServers, startRealtime, stopRealtime]);

  async function handleLogout(): Promise<void> {
    resetTavern();
    await logout();
  }

  return (
    <Screen padded={false}>
      <View style={styles.root}>
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text style={styles.instanceName}>{instanceInfo?.name ?? 'Tavern'}</Text>
            <Text style={styles.memberLine}>{me?.displayName ?? me?.username ?? 'Member'}</Text>
          </View>
          <StatusPill label={gatewayStatusLabel(gatewayStatus)} tone={gatewayStatusTone(gatewayStatus)} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Log out"
            onPress={() => void handleLogout()}
            style={styles.iconButton}
          >
            <Feather name="log-out" size={18} color={colors.fg} />
          </Pressable>
        </View>

        <ServerStrip
          servers={servers}
          activeServerId={activeServerId}
          loading={loadingServers}
          onSelect={(serverId) => void selectServer(serverId)}
        />

        <ErrorBanner message={error} />

        {activeChannel ? (
          <MessageThread
            channel={activeChannel}
            messages={messages}
            loading={Boolean(loadingMessagesByChannel[activeChannel.id])}
            onBack={clearChannel}
            onSend={(content) => sendMessage(activeChannel.id, content)}
          />
        ) : (
          <RoomList
            server={activeServer}
            channels={channels}
            loading={Boolean(activeServerId && loadingChannelsByServer[activeServerId])}
            onSelect={(channelId) => void selectChannel(channelId)}
          />
        )}
      </View>
    </Screen>
  );
}

interface ServerStripProps {
  servers: Server[];
  activeServerId: string | null;
  loading: boolean;
  onSelect: (serverId: string) => void;
}

function ServerStrip({ servers, activeServerId, loading, onSelect }: ServerStripProps): JSX.Element {
  const renderItem = useCallback<ListRenderItem<Server>>(
    ({ item }) => (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${item.name}`}
        onPress={() => onSelect(item.id)}
        style={[styles.serverChip, activeServerId === item.id && styles.serverChipActive]}
      >
        <Text style={styles.serverInitial}>{item.name.slice(0, 1).toUpperCase()}</Text>
        <Text style={styles.serverChipLabel} numberOfLines={1}>
          {item.name}
        </Text>
      </Pressable>
    ),
    [activeServerId, onSelect],
  );

  if (!loading && servers.length === 0) {
    return (
      <View style={styles.serverEmpty}>
        <Text style={styles.mutedText}>No taverns yet.</Text>
      </View>
    );
  }

  return (
    <FlatList
      horizontal
      data={servers}
      keyExtractor={(item) => item.id}
      renderItem={renderItem}
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.serverStripContent}
      style={styles.serverStrip}
    />
  );
}

interface RoomListProps {
  server: Server | null;
  channels: Channel[];
  loading: boolean;
  onSelect: (channelId: string) => void;
}

function RoomList({ server, channels, loading, onSelect }: RoomListProps): JSX.Element {
  const rooms = useMemo(
    () => channels.filter((channel) => channel.type !== 'category'),
    [channels],
  );
  const renderItem = useCallback<ListRenderItem<Channel>>(
    ({ item }) => {
      const canOpen = CHAT_ROOM_TYPES.has(item.type);
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${item.name}`}
          disabled={!canOpen}
          onPress={() => onSelect(item.id)}
          style={[styles.roomRow, !canOpen && styles.roomRowDisabled]}
        >
          <View style={styles.roomIcon}>
            <Feather name={roomIcon(item.type)} size={17} color={colors.emberStrong} />
          </View>
          <View style={styles.roomBody}>
            <Text style={styles.roomName}>{item.name}</Text>
            <Text style={styles.roomMeta}>
              {canOpen ? item.topic ?? 'Room messages' : 'Coming in a later mobile slice'}
            </Text>
          </View>
          <Feather name="chevron-right" size={18} color={colors.fgSubtle} />
        </Pressable>
      );
    },
    [onSelect],
  );

  if (!server) {
    return <EmptyState title="Choose a tavern" body="Pick a tavern above to see its rooms." />;
  }

  if (!loading && rooms.length === 0) {
    return <EmptyState title="No rooms yet" body="Create rooms on web, then they will appear here." />;
  }

  return (
    <View style={styles.panel}>
      <View style={styles.panelHeader}>
        <Text style={styles.panelTitle}>{server.name}</Text>
        <Text style={styles.panelSubtitle}>Rooms</Text>
      </View>
      <FlatList
        data={rooms}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={styles.roomListContent}
      />
    </View>
  );
}

interface MessageThreadProps {
  channel: Channel;
  messages: Message[];
  loading: boolean;
  onBack: () => void;
  onSend: (content: string) => Promise<void>;
}

function MessageThread({ channel, messages, loading, onBack, onSend }: MessageThreadProps): JSX.Element {
  const listRef = useRef<FlatList<Message>>(null);

  const renderItem = useCallback<ListRenderItem<Message>>(
    ({ item }) => <MessageRow message={item} />,
    [],
  );

  useEffect(() => {
    if (messages.length === 0) return;
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
  }, [messages.length]);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.thread}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 18 : 0}
    >
      <View style={styles.threadHeader}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to rooms"
          onPress={onBack}
          style={styles.iconButton}
        >
          <Feather name="chevron-left" size={20} color={colors.fg} />
        </Pressable>
        <View style={styles.threadHeaderCopy}>
          <Text style={styles.roomName}>{channel.name}</Text>
          <Text style={styles.roomMeta}>{channel.topic ?? 'Room messages'}</Text>
        </View>
      </View>
      {loading && messages.length === 0 ? (
        <EmptyState title="Loading messages" body="Fetching the latest table talk." icon="message-circle" />
      ) : messages.length === 0 ? (
        <EmptyState title="No messages yet" body="Start the conversation from your phone." />
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.messageListContent}
        />
      )}
      <MessageComposer onSend={onSend} />
    </KeyboardAvoidingView>
  );
}

const MessageRow = memo(function MessageRow({ message }: { message: Message }): JSX.Element {
  const hasText = message.content.trim().length > 0;
  return (
    <View style={styles.messageRow}>
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>
          {message.author.displayName.slice(0, 1).toUpperCase()}
        </Text>
      </View>
      <View style={styles.messageBody}>
        <View style={styles.messageMetaRow}>
          <Text style={styles.messageAuthor}>{message.author.displayName}</Text>
          <Text style={styles.messageTime}>{formatTime(message.createdAt)}</Text>
        </View>
        <Text style={styles.messageText}>
          {hasText ? message.content : 'Sent an attachment'}
        </Text>
        {message.attachmentIds.length > 0 ? (
          <Text style={styles.attachmentHint}>{message.attachmentIds.length} attachment</Text>
        ) : null}
      </View>
    </View>
  );
});

function MessageComposer({ onSend }: { onSend: (content: string) => Promise<void> }): JSX.Element {
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(): Promise<void> {
    if (!content.trim()) return;
    setSending(true);
    setError(null);
    try {
      await onSend(content);
      setContent('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send this message.');
    } finally {
      setSending(false);
    }
  }

  return (
    <View style={styles.composerWrap}>
      {error ? <Text style={styles.composerError}>{error}</Text> : null}
      <View style={styles.composer}>
        <TextInput
          value={content}
          onChangeText={setContent}
          placeholder="Message this room"
          placeholderTextColor={colors.fgSubtle}
          selectionColor={colors.emberStrong}
          multiline
          style={styles.composerInput}
        />
        <Button
          label="Send"
          icon="send"
          onPress={() => void send()}
          loading={sending}
          disabled={!content.trim()}
          style={styles.sendButton}
        />
      </View>
    </View>
  );
}

function roomIcon(type: Channel['type']): keyof typeof Feather.glyphMap {
  switch (type) {
    case 'voice':
    case 'stage':
      return 'volume-2';
    case 'campaign':
    case 'session':
      return 'book-open';
    case 'board_game':
      return 'grid';
    case 'forum':
      return 'message-square';
    default:
      return 'hash';
  }
}

function gatewayStatusLabel(status: string): string {
  switch (status) {
    case 'ready':
      return 'Live';
    case 'connecting':
      return 'Connecting';
    case 'reconnecting':
      return 'Reconnecting';
    default:
      return 'Offline';
  }
}

function gatewayStatusTone(status: string): 'neutral' | 'good' | 'warn' | 'info' {
  switch (status) {
    case 'ready':
      return 'good';
    case 'connecting':
      return 'info';
    case 'reconnecting':
      return 'warn';
    default:
      return 'neutral';
  }
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    gap: spacing.sm,
    paddingTop: spacing.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  headerCopy: {
    flex: 1,
  },
  instanceName: {
    color: colors.fg,
    fontSize: typography.title,
    fontWeight: '900',
    letterSpacing: 0,
  },
  memberLine: {
    color: colors.fgMuted,
    fontSize: typography.caption,
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  serverStrip: {
    flexGrow: 0,
    minHeight: 72,
  },
  serverStripContent: {
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  serverChip: {
    width: 92,
    minHeight: 64,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: spacing.sm,
    alignItems: 'center',
    gap: spacing.xs,
  },
  serverChipActive: {
    backgroundColor: colors.tintEmber,
    borderColor: colors.ember,
  },
  serverInitial: {
    color: colors.emberStrong,
    fontSize: typography.bodyLarge,
    fontWeight: '900',
  },
  serverChipLabel: {
    color: colors.fg,
    fontSize: typography.tiny,
    fontWeight: '700',
    textAlign: 'center',
  },
  serverEmpty: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  mutedText: {
    color: colors.fgMuted,
  },
  panel: {
    flex: 1,
  },
  panelHeader: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  panelTitle: {
    color: colors.fg,
    fontSize: typography.title,
    fontWeight: '900',
    letterSpacing: 0,
  },
  panelSubtitle: {
    color: colors.fgMuted,
    fontSize: typography.caption,
  },
  roomListContent: {
    padding: spacing.lg,
    gap: spacing.sm,
  },
  roomRow: {
    minHeight: 68,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  roomRowDisabled: {
    opacity: 0.55,
  },
  roomIcon: {
    width: 34,
    height: 34,
    borderRadius: radii.sm,
    backgroundColor: colors.tintEmber,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roomBody: {
    flex: 1,
    gap: spacing.xs,
  },
  roomName: {
    color: colors.fg,
    fontSize: typography.bodyLarge,
    fontWeight: '800',
    letterSpacing: 0,
  },
  roomMeta: {
    color: colors.fgMuted,
    fontSize: typography.caption,
  },
  thread: {
    flex: 1,
  },
  threadHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  threadHeaderCopy: {
    flex: 1,
  },
  messageListContent: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  messageRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: colors.emberStrong,
    fontWeight: '900',
  },
  messageBody: {
    flex: 1,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.xs,
  },
  messageMetaRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.sm,
  },
  messageAuthor: {
    color: colors.fg,
    fontWeight: '800',
    fontSize: typography.caption,
  },
  messageTime: {
    color: colors.fgSubtle,
    fontSize: typography.tiny,
  },
  messageText: {
    color: colors.fg,
    fontSize: typography.body,
    lineHeight: 21,
  },
  attachmentHint: {
    color: colors.emberStrong,
    fontSize: typography.caption,
    fontWeight: '700',
  },
  composerWrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
    backgroundColor: colors.canvas,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
  },
  composerInput: {
    flex: 1,
    maxHeight: 112,
    minHeight: 46,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.sunken,
    color: colors.fg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: typography.body,
  },
  sendButton: {
    width: 98,
  },
  composerError: {
    color: colors.danger,
    fontSize: typography.caption,
  },
});
