import type { RoomDestroyReason, RoomStatus } from './constants';

export type B64 = string;

export interface MemberDto {
  slot: number;
  gen: number;
  nick: B64 | null;
  nickNonce: B64 | null;
  online: boolean;
  isCreator: boolean;
  joinedAt: number;
}

export interface MessageDto {
  seq: number;
  clientMsgId: string;
  senderSlot: number;
  nonce: B64;
  ct: B64;
  kind: 'text' | 'file' | 'image' | 'system';
  attachmentId: string | null;
  at: number;
}

export type ClientFrame =
  | { t: 'join'; roomId: string; proof: B64; nick: B64; nickNonce: B64; maxMembers?: number }
  | { t: 'msg:send'; reqId: string; clientMsgId: string; kind: 'text' | 'file' | 'image'; nonce: B64; ct: B64; attachmentId?: string }
  | { t: 'sync'; sinceSeq: number }
  | { t: 'nick:set'; nick: B64; nickNonce: B64 }
  | { t: 'upload:create'; attachmentId: string; chunkSize: number; chunkCount: number; totalBytes: number; meta: B64; metaNonce: B64; kind: 'file' | 'image' }
  | { t: 'upload:complete'; attachmentId: string }
  | { t: 'upload:abort'; attachmentId: string }
  | { t: 'destroy'; creatorToken: string }
  | { t: 'leave' }
  | { t: 'ping' };

export type ServerFrame =
  | { t: 'hello'; proto: number; serverNonce: B64; maxMembers: number; chunkSizeMax: number }
  | { t: 'join:ok'; roomId: string; slot: number; gen: number; headSeq: number; sessionToken: string; isCreator: boolean; members: MemberDto[]; oldestSeq: number }
  | { t: 'join:err'; code: string }
  | { t: 'msg:new'; msg: MessageDto }
  | { t: 'msg:ack'; reqId: string; clientMsgId: string; seq: number; at: number; dup: boolean }
  | { t: 'msg:nack'; reqId: string; clientMsgId: string; code: string }
  | { t: 'sync:ok'; msgs: MessageDto[]; fromSeq: number; headSeq: number }
  | { t: 'sync:gap'; oldestSeq: number; headSeq: number }
  | { t: 'members'; members: MemberDto[] }
  | { t: 'upload:ready'; attachmentId: string; chunkSize: number; chunkCount: number }
  | { t: 'upload:err'; attachmentId: string; code: string }
  | { t: 'attachment:ready'; attachmentId: string; chunkCount: number }
  | { t: 'room:destroying'; reason: RoomDestroyReason }
  | { t: 'room:destroyed'; reason: RoomDestroyReason }
  | { t: 'room:status'; status: RoomStatus; online: number }
  | { t: 'error'; code: string; message: string }
  | { t: 'pong'; at: number };

export interface CreateRoomRequest {
  roomId: string;
  joinKey: B64;
  maxMembers: number;
}

export interface CreateRoomResponse {
  roomId: string;
  creatorToken: string;
}

export interface RoomStatusResponse {
  status: 'ACTIVE' | 'DESTROYED' | 'UNKNOWN';
  online?: number;
  maxMembers?: number;
}

export interface HistoryPage {
  msgs: MessageDto[];
  oldestSeq: number;
  hasMore: boolean;
}

export interface AttachmentIndex {
  attachmentId: string;
  roomId: string;
  chunkSize: number;
  chunkCount: number;
  totalBytes: number;
  meta: B64;
  metaNonce: B64;
  kind: 'file' | 'image';
  uploadedChunks: number[];
  complete: boolean;
}
