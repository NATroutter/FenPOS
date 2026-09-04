/**
 * The header carrying the address that actually opened the connection.
 *
 * Its own module, holding one string, for the reason `lib/link/link-path.ts` is: `server.ts` writes
 * this header and `lib/request-context.ts` reads it, and `request-context.ts` is `server-only`, so a
 * plain Node entry point importing it would fail at load. A constant both sides can name without
 * either importing the other is what keeps the two spellings from drifting apart silently — and a
 * drift here is quiet in the worst direction, because the reader would simply see no peer and treat
 * every caller as unknown.
 *
 * Deliberately not a name any proxy sets. An operator forwarding `X-Real-IP` or `X-Forwarded-For`
 * through cannot forward this one by accident, and `server.ts` deletes any inbound copy before
 * writing its own regardless.
 */
export const PEER_ADDRESS_HEADER = "x-fenpos-peer";
