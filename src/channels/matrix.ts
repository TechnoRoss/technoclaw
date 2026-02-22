/**
 * Matrix Channel for NanoClaw
 * Connects to a Matrix homeserver via matrix-js-sdk
 */
import sdk, {
  ClientEvent,
  MatrixClient,
  MatrixEvent,
  MsgType,
  Room,
  RoomEvent,
  RoomMemberEvent,
} from 'matrix-js-sdk';

import { ASSISTANT_NAME } from '../config.js';
import { logger } from '../logger.js';
import { Channel, NewMessage, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';

export interface MatrixChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class MatrixChannel implements Channel {
  name = 'matrix';

  private client!: MatrixClient;
  private connected = false;
  private userId = '';
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private opts: MatrixChannelOpts;

  constructor(opts: MatrixChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const homeserverUrl = process.env.MATRIX_HOMESERVER;
    const username = process.env.MATRIX_USERNAME;
    const password = process.env.MATRIX_PASSWORD;
    const accessToken = process.env.MATRIX_ACCESS_TOKEN;

    if (!homeserverUrl) {
      throw new Error('MATRIX_HOMESERVER environment variable is required');
    }

    this.client = sdk.createClient({
      baseUrl: homeserverUrl,
    });

    // Login with access token or username/password
    if (accessToken) {
      this.client = sdk.createClient({
        baseUrl: homeserverUrl,
        accessToken,
        userId: process.env.MATRIX_USER_ID,
      });
      this.userId = process.env.MATRIX_USER_ID || '';
      logger.info('Using existing access token');
    } else if (username && password) {
      const loginResponse = await this.client.login('m.login.password', {
        user: username,
        password,
      });
      this.userId = loginResponse.user_id;

      // Recreate client with access token for SDK sync
      this.client = sdk.createClient({
        baseUrl: homeserverUrl,
        accessToken: loginResponse.access_token,
        userId: this.userId,
      });
      logger.info({ userId: this.userId }, 'Logged in to Matrix');
    } else {
      throw new Error(
        'Either MATRIX_ACCESS_TOKEN or MATRIX_USERNAME+MATRIX_PASSWORD required',
      );
    }

    // Auto-join rooms when invited
    this.client.on(RoomMemberEvent.Membership, (event: MatrixEvent, member) => {
      if (member.membership === 'invite' && member.userId === this.userId) {
        this.client.joinRoom(member.roomId).then(() => {
          logger.info({ roomId: member.roomId }, 'Auto-joined room on invite');
        }).catch((err) => {
          logger.error({ roomId: member.roomId, err }, 'Failed to auto-join room');
        });
      }
    });

    // Listen for incoming messages
    this.client.on(RoomEvent.Timeline, (event: MatrixEvent, room: Room | undefined) => {
      if (!room) return;
      if (event.getType() !== 'm.room.message') return;

      // Ignore our own messages
      const sender = event.getSender();
      if (sender === this.userId) return;

      // Ignore old messages during initial sync
      if (!this.connected) return;

      const roomId = room.roomId;
      const content = event.getContent();
      const body = content.body || '';
      const timestamp = new Date(event.getTs()).toISOString();

      // Notify about chat metadata for room discovery
      const roomName = room.name || roomId;
      this.opts.onChatMetadata(roomId, timestamp, roomName);

      // Only deliver full message for registered groups
      const groups = this.opts.registeredGroups();
      if (groups[roomId]) {
        const senderName = room.getMember(sender || '')?.name || sender || 'unknown';
        const isBotMessage = body.startsWith(`${ASSISTANT_NAME}:`);

        this.opts.onMessage(roomId, {
          id: event.getId() || '',
          chat_jid: roomId,
          sender: sender || '',
          sender_name: senderName,
          content: body,
          timestamp,
          is_from_me: false,
          is_bot_message: isBotMessage,
        });
      }
    });

    // Start sync and wait for initial sync to complete
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Matrix sync timed out after 30s'));
      }, 30000);

      this.client.once(ClientEvent.Sync, (state: string) => {
        clearTimeout(timeout);
        if (state === 'PREPARED') {
          this.connected = true;
          logger.info('Matrix sync complete, connected');

          // Flush any queued messages
          this.flushOutgoingQueue().catch((err) =>
            logger.error({ err }, 'Failed to flush outgoing queue'),
          );

          resolve();
        } else {
          reject(new Error(`Matrix sync failed with state: ${state}`));
        }
      });

      this.client.startClient({ initialSyncLimit: 0 });
    });
  }

  async sendMessage(roomId: string, text: string): Promise<void> {
    if (!this.connected) {
      this.outgoingQueue.push({ jid: roomId, text });
      logger.info(
        { roomId, length: text.length, queueSize: this.outgoingQueue.length },
        'Matrix disconnected, message queued',
      );
      return;
    }
    try {
      await this.client.sendMessage(roomId, {
        msgtype: MsgType.Text,
        body: text,
      });
      logger.info({ roomId, length: text.length }, 'Message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid: roomId, text });
      logger.warn(
        { roomId, err, queueSize: this.outgoingQueue.length },
        'Failed to send, message queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    // Matrix room IDs start with !
    return jid.startsWith('!');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.client?.stopClient();
  }

  async setTyping(roomId: string, isTyping: boolean): Promise<void> {
    try {
      await this.client.sendTyping(roomId, isTyping, isTyping ? 30000 : 0);
    } catch (err) {
      logger.debug({ roomId, err }, 'Failed to update typing status');
    }
  }

  /**
   * Get all joined rooms with their names.
   * Useful for group discovery.
   */
  getJoinedRooms(): Array<{ roomId: string; name: string }> {
    const rooms = this.client.getRooms();
    return rooms.map((room) => ({
      roomId: room.roomId,
      name: room.name || room.roomId,
    }));
  }

  private async flushOutgoingQueue(): Promise<void> {
    while (this.outgoingQueue.length > 0 && this.connected) {
      const item = this.outgoingQueue.shift()!;
      try {
        await this.sendMessage(item.jid, item.text);
      } catch (err) {
        logger.error({ err, jid: item.jid }, 'Failed to flush queued message');
      }
    }
  }
}
