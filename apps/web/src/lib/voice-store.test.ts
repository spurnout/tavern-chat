import { beforeEach, describe, expect, it } from 'vitest';
import type { Channel, VoiceStateGatewayPayload } from '@tavern/shared';
import { useRealtime } from './store.js';

const SERVER_ID = '01HSERVER000000000000000';
const CHANNEL_ID = '01HVOICE0000000000000000';
const USER_ID = '01HUSER000000000000000000';

function voiceChannel(
  voiceStates: VoiceStateGatewayPayload[] | undefined,
): Channel {
  return {
    id: CHANNEL_ID,
    serverId: SERVER_ID,
    parentId: null,
    campaignId: null,
    gameNightId: null,
    type: 'voice',
    name: 'Voice Hall',
    topic: null,
    position: 0,
    nsfw: false,
    videoEnabled: true,
    federationMode: 'inherit',
    voiceStates,
    createdAt: '2026-06-11T12:00:00.000Z',
  };
}

function voiceState(
  overrides: Partial<VoiceStateGatewayPayload> = {},
): VoiceStateGatewayPayload {
  return {
    serverId: SERVER_ID,
    userId: USER_ID,
    channelId: CHANNEL_ID,
    selfMute: false,
    selfDeaf: false,
    cameraOn: false,
    screenSharing: false,
    joinedAt: '2026-06-11T12:00:00.000Z',
    stagePosition: null,
    handRaisedAt: null,
    ...overrides,
  };
}

function resetStore(): void {
  useRealtime.setState({
    channelsByServer: {},
    voiceStatesByChannel: {},
  });
}

describe('realtime store — voice room hydration', () => {
  beforeEach(() => {
    resetStore();
  });

  it('hydrates voice occupants from the room list payload', () => {
    const state = voiceState({ screenSharing: true });

    useRealtime.getState().upsertChannels(SERVER_ID, [voiceChannel([state])]);

    expect(useRealtime.getState().voiceStatesByChannel[CHANNEL_ID]).toEqual({
      [USER_ID]: state,
    });
  });

  it('clears a room when the refreshed payload has no active occupants', () => {
    useRealtime.getState().applyVoiceState(voiceState());

    useRealtime.getState().upsertChannels(SERVER_ID, [voiceChannel([])]);

    expect(useRealtime.getState().voiceStatesByChannel[CHANNEL_ID]).toEqual({});
  });

  it('preserves the voice snapshot reference when a refresh is unchanged', () => {
    const state = voiceState({ screenSharing: true });
    useRealtime.getState().upsertChannels(SERVER_ID, [voiceChannel([state])]);
    const firstMap = useRealtime.getState().voiceStatesByChannel;
    const firstRoom = firstMap[CHANNEL_ID];

    useRealtime
      .getState()
      .upsertChannels(SERVER_ID, [voiceChannel([{ ...state }])]);

    expect(useRealtime.getState().voiceStatesByChannel).toBe(firstMap);
    expect(useRealtime.getState().voiceStatesByChannel[CHANNEL_ID]).toBe(firstRoom);
  });
});
