# Watch Together

A Teleparty-style prototype for private watch rooms: invite codes, synced playback, chat, presence, reactions, and WebRTC signaling for mic/camera calls.

## Run it

```bash
npm start
```

Open `http://localhost:3000`, create a room, then share the invite URL or six-character room code.

## Playback model

This repo starts with two modes:

- `Direct sync`: everyone loads the same direct video URL in their own browser and the host's playback state is broadcast to the room. This is the simplest Teleparty-like model for files and sources that can be played by a normal `<video>` element.
- `Embed source`: paste an embeddable player URL such as `https://ritzembeds.pages.dev/embed/fox4k-usa`. The room renders it in an iframe with autoplay, encrypted-media, picture-in-picture, and fullscreen permissions. Cross-origin embeds usually cannot be play/pause/seek-synced unless that player exposes a compatible `postMessage` API.
- `Server browser`: a placeholder control plane for the Linux-server idea. A production version would attach a worker that runs Chromium/Firefox, captures video/audio, encodes it to WebRTC, and publishes it to the room through an SFU such as mediasoup, Janus, LiveKit, or GStreamer/WebRTC.

For Netflix/Prime/Disney-style DRM sites, a normal website generally cannot embed and control those players directly. Teleparty solves that with browser extensions running on each viewer's machine. A hosted browser stream can be technically possible for content you control or are allowed to retransmit, but DRM and platform terms need careful review before building it into the product.

## What's included

- In-memory room creation with six-character access codes.
- Host keys so only the creator gets host controls by default.
- Realtime WebSocket room events without external dependencies.
- Chat, system messages, reactions, and participant presence.
- Playback state sync with drift correction.
- WebRTC offer/answer/ICE signaling for peer mic/camera chat.
- Room settings for host-only controls, chat, mic, and camera.

## Production next steps

- Replace in-memory rooms with Redis or Postgres.
- Add auth, room moderation, expiring invites, and rate limits.
- Add TURN credentials for reliable WebRTC outside a LAN.
- Add an SFU for group media instead of peer-to-peer meshes.
- Build the Linux browser worker for server-browser rooms.
- Add browser extensions if the goal is true Teleparty-style sync on major streaming sites.
