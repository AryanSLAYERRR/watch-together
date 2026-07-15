const runtimeConfig = window.WATCH_TOGETHER_CONFIG || {};
const backendUrl = normalizeBackendUrl(runtimeConfig.backendUrl || "");

const state = {
  socket: null,
  reconnectTimer: null,
  clientId: null,
  room: null,
  isHost: false,
  hostKey: sessionStorage.getItem("hostKey") || "",
  name: localStorage.getItem("watchName") || "",
  suppressPlayback: false,
  lastPlaybackSentAt: 0,
  localStream: null,
  peers: new Map(),
  knownParticipants: new Map(),
  bootStartedAt: performance.now(),
  bootDone: false
};

const els = {
  bootScreen: document.querySelector("#bootScreen"),
  bootStatus: document.querySelector("#bootStatus"),
  lobbyView: document.querySelector("#lobbyView"),
  roomView: document.querySelector("#roomView"),
  lobbyConnection: document.querySelector("#lobbyConnection"),
  createForm: document.querySelector("#createForm"),
  joinForm: document.querySelector("#joinForm"),
  roomMode: document.querySelector("#roomMode"),
  roomTitle: document.querySelector("#roomTitle"),
  roomCodeBadge: document.querySelector("#roomCodeBadge"),
  sourceLabel: document.querySelector("#sourceLabel"),
  hostBadge: document.querySelector("#hostBadge"),
  syncStatus: document.querySelector("#syncStatus"),
  videoFrame: document.querySelector("#videoFrame"),
  watchVideo: document.querySelector("#watchVideo"),
  watchEmbed: document.querySelector("#watchEmbed"),
  remotePlaceholder: document.querySelector("#remotePlaceholder"),
  emptySource: document.querySelector("#emptySource"),
  sourceInput: document.querySelector("#sourceInput"),
  updateSource: document.querySelector("#updateSource"),
  syncNow: document.querySelector("#syncNow"),
  requestBrowser: document.querySelector("#requestBrowser"),
  customReactionForm: document.querySelector("#customReactionForm"),
  customReactionInput: document.querySelector("#customReactionInput"),
  participants: document.querySelector("#participants"),
  participantCount: document.querySelector("#participantCount"),
  chatLog: document.querySelector("#chatLog"),
  chatForm: document.querySelector("#chatForm"),
  chatInput: document.querySelector("#chatInput"),
  chatState: document.querySelector("#chatState"),
  toggleMic: document.querySelector("#toggleMic"),
  toggleCamera: document.querySelector("#toggleCamera"),
  localPreviewWrap: document.querySelector("#localPreviewWrap"),
  localPreview: document.querySelector("#localPreview"),
  remoteGrid: document.querySelector("#remoteGrid"),
  settingsSection: document.querySelector("#settingsSection"),
  hostOnlyToggle: document.querySelector("#hostOnlyToggle"),
  chatToggle: document.querySelector("#chatToggle"),
  voiceToggle: document.querySelector("#voiceToggle"),
  videoToggle: document.querySelector("#videoToggle"),
  copyInvite: document.querySelector("#copyInvite"),
  leaveRoom: document.querySelector("#leaveRoom"),
  toastArea: document.querySelector("#toastArea")
};

connect();
prefillNames();

els.createForm.addEventListener("submit", createRoom);
els.joinForm.addEventListener("submit", joinRoom);
els.chatForm.addEventListener("submit", sendChat);
els.updateSource.addEventListener("click", updateSource);
els.syncNow.addEventListener("click", () => sendPlayback(true));
els.requestBrowser.addEventListener("click", () => send({ type: "remote-browser:request" }));
els.copyInvite.addEventListener("click", copyInvite);
els.leaveRoom.addEventListener("click", leaveCurrentRoom);
els.toggleMic.addEventListener("click", () => toggleMedia("audio"));
els.toggleCamera.addEventListener("click", () => toggleMedia("video"));
document.querySelectorAll("[data-reaction-preset]").forEach((button) => {
  button.addEventListener("click", () => sendReaction(button.dataset.reactionPreset));
});
els.customReactionForm.addEventListener("submit", sendCustomReaction);

[els.hostOnlyToggle, els.chatToggle, els.voiceToggle, els.videoToggle].forEach((input) => {
  input.addEventListener("change", sendSettings);
});

["play", "pause", "seeked", "ratechange", "loadedmetadata"].forEach((eventName) => {
  els.watchVideo.addEventListener(eventName, () => {
    if (!canControlPlayback()) return;
    if (state.suppressPlayback) return;
    sendPlayback(eventName === "seeked" || eventName === "loadedmetadata");
  });
});

setInterval(() => {
  if (!canControlPlayback()) return;
  if (els.watchVideo.paused || state.room?.mode !== "direct-sync") return;
  if (sourceKind(state.room.source?.url) !== "video") return;
  sendPlayback(false);
}, 4500);

function connect() {
  state.socket = new WebSocket(websocketUrl("/ws"));

  state.socket.addEventListener("open", () => {
    setConnection(true);
    const code = new URLSearchParams(location.search).get("room");
    if (code && !state.room) {
      setBootStatus("Joining room...");
      const savedName = state.name || "Friend";
      send({ type: "join", code, name: savedName, hostKey: state.hostKey });
    } else {
      completeBoot("Ready");
    }
  });

  state.socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    handleMessage(message);
  });

  state.socket.addEventListener("error", () => {
    setConnection(false);
  });

  state.socket.addEventListener("close", () => {
    setConnection(false);
    setBootStatus(backendUrl ? "Backend reconnecting..." : "Realtime server unavailable...");
    if (!state.bootDone) completeBoot("Offline");
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(connect, 1200);
  });
}

async function createRoom(event) {
  event.preventDefault();
  setBootStatus("Creating room...");
  const form = new FormData(els.createForm);
  const name = clean(form.get("name")) || "Host";
  persistName(name);

  let response;
  try {
    response = await fetch(apiUrl("/api/rooms"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: form.get("title"),
        sourceUrl: form.get("sourceUrl"),
        mode: form.get("mode"),
        hostOnlyControls: form.get("hostOnlyControls") === "on",
        voiceEnabled: form.get("voiceEnabled") === "on",
        videoEnabled: form.get("videoEnabled") === "on"
      })
    });
  } catch {
    completeBoot("Ready");
    toast("Could not reach the realtime backend.");
    return;
  }

  if (!response.ok) {
    completeBoot("Ready");
    toast("Could not create the room.");
    return;
  }

  const data = await response.json();
  state.hostKey = data.hostKey;
  sessionStorage.setItem("hostKey", state.hostKey);
  history.replaceState(null, "", `/?room=${data.code}`);
  send({ type: "join", code: data.code, name, hostKey: state.hostKey });
}

function joinRoom(event) {
  event.preventDefault();
  setBootStatus("Joining room...");
  const form = new FormData(els.joinForm);
  const name = clean(form.get("name")) || "Friend";
  const code = clean(form.get("code")).toUpperCase();
  persistName(name);
  history.replaceState(null, "", `/?room=${code}`);
  send({ type: "join", code, name, hostKey: state.hostKey });
}

function handleMessage(message) {
  if (message.type === "hello") {
    state.clientId = message.clientId;
    setBootStatus("Connection ready...");
    return;
  }

  if (message.type === "error") {
    completeBoot("Ready");
    toast(message.error || "Something went wrong.");
    return;
  }

  if (message.type === "joined") {
    state.clientId = message.clientId;
    state.isHost = message.isHost;
    applyRoom(message.room);
    showRoom();
    completeBoot("Room ready");
    toast(state.isHost ? "Room created. Share the code." : "Joined room.");
    return;
  }

  if (message.type === "left") {
    showLobby();
    return;
  }

  if (message.type === "room:update") {
    applyRoom(message.room);
    return;
  }

  if (message.type === "presence") {
    renderParticipants(message.participants);
    handleNewParticipants(message.participants);
    return;
  }

  if (message.type === "chat") {
    appendMessage(message.message);
    return;
  }

  if (message.type === "reaction") {
    showReaction(message.reaction);
    return;
  }

  if (message.type === "playback") {
    applyPlayback(message.playback, message.from);
    return;
  }

  if (message.type === "signal") {
    handleSignal(message.from, message.signal);
  }
}

function applyRoom(room) {
  state.room = room;
  els.roomTitle.textContent = room.title;
  els.roomCodeBadge.textContent = room.code;
  els.sourceLabel.textContent = room.source?.label || "No source";
  els.roomMode.textContent = room.mode === "remote-browser" ? "Server browser" : "Direct sync";
  els.hostBadge.textContent = state.isHost ? "Host" : "Viewer";
  els.settingsSection.classList.toggle("hidden", !state.isHost);
  els.requestBrowser.disabled = !state.isHost;

  els.hostOnlyToggle.checked = Boolean(room.settings.hostOnlyControls);
  els.chatToggle.checked = Boolean(room.settings.chatEnabled);
  els.voiceToggle.checked = Boolean(room.settings.voiceEnabled);
  els.videoToggle.checked = Boolean(room.settings.videoEnabled);
  els.chatInput.disabled = !room.settings.chatEnabled;
  els.chatState.textContent = room.settings.chatEnabled ? "Ready" : "Disabled";
  els.toggleMic.disabled = !room.settings.voiceEnabled;
  els.toggleCamera.disabled = !room.settings.videoEnabled;
  if (!room.settings.voiceEnabled && mediaEnabled("audio")) stopMedia("audio");
  if (!room.settings.videoEnabled && mediaEnabled("video")) stopMedia("video");
  updateMediaButtons();
  els.sourceInput.value = room.source?.url || "";
  els.updateSource.disabled = !canControlPlayback();
  els.syncNow.disabled = !canControlPlayback() || sourceKind(room.source?.url) !== "video";

  renderStage();
  renderParticipants(room.participants || []);
  renderMessages(room.messages || []);
}

function renderStage() {
  const room = state.room;
  const isRemote = room.mode === "remote-browser";
  const hasSource = Boolean(room.source?.url);
  const kind = sourceKind(room.source?.url);

  els.remotePlaceholder.classList.toggle("hidden", !isRemote);
  els.emptySource.classList.toggle("hidden", isRemote || hasSource);
  els.watchVideo.classList.toggle("hidden", isRemote || !hasSource || kind !== "video");
  els.watchEmbed.classList.toggle("hidden", isRemote || !hasSource || kind !== "embed");

  if (isRemote) {
    els.watchVideo.pause();
    els.watchVideo.removeAttribute("src");
    els.watchVideo.load();
    els.watchEmbed.removeAttribute("src");
    setSyncStatus("Server stream", "warn");
    return;
  }

  if (!hasSource) {
    els.watchVideo.pause();
    els.watchVideo.removeAttribute("src");
    els.watchVideo.load();
    els.watchEmbed.removeAttribute("src");
    setSyncStatus("No source", "warn");
    return;
  }

  if (kind === "embed") {
    els.watchVideo.pause();
    els.watchVideo.removeAttribute("src");
    els.watchVideo.load();
    if (els.watchEmbed.src !== room.source.url) {
      els.watchEmbed.src = room.source.url;
    }
    setSyncStatus("Embed loaded", "warn");
    return;
  }

  els.watchEmbed.removeAttribute("src");
  if (hasSource && els.watchVideo.currentSrc !== room.source.url) {
    state.suppressPlayback = true;
    els.watchVideo.src = room.source.url;
    els.watchVideo.load();
    setTimeout(() => {
      state.suppressPlayback = false;
      applyPlayback(room.playback);
    }, 250);
  }
}

function renderParticipants(participants) {
  state.knownParticipants = new Map(participants.map((person) => [person.id, person]));
  els.participantCount.textContent = String(participants.length);
  els.participants.replaceChildren(...participants.map(renderParticipant));
}

function renderParticipant(person) {
  const node = document.createElement("div");
  node.className = "participant";
  const initials = clean(person.name).slice(0, 2).toUpperCase() || "?";
  node.innerHTML = `
    <div class="avatar">${escapeHtml(initials)}</div>
    <div>
      <strong>${escapeHtml(person.name)}${person.id === state.clientId ? " (you)" : ""}</strong>
      <small>${person.isHost ? "Host" : "Viewer"} - ${person.media.audio ? "Mic on" : "Mic off"} - ${person.media.video ? "Cam on" : "Cam off"}</small>
    </div>
    <small>${person.isHost ? "Sync" : ""}</small>
  `;
  return node;
}

function renderMessages(messages) {
  els.chatLog.replaceChildren();
  messages.forEach(appendMessage);
}

function appendMessage(message) {
  const node = document.createElement("div");
  node.className = `message ${message.type === "system" ? "system" : ""}`;
  if (message.type === "system") {
    node.textContent = message.text;
  } else {
    node.innerHTML = `<strong>${escapeHtml(message.name)}</strong><p>${escapeHtml(message.text)}</p>`;
  }
  els.chatLog.append(node);
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

function sendChat(event) {
  event.preventDefault();
  const text = clean(els.chatInput.value);
  if (!text) return;
  send({ type: "chat", text });
  els.chatInput.value = "";
}

function updateSource() {
  if (!canControlPlayback()) return;
  send({ type: "source:update", sourceUrl: els.sourceInput.value });
}

function sendCustomReaction(event) {
  event.preventDefault();
  const reaction = normalizeReaction(els.customReactionInput.value);
  if (!reaction) {
    toast("Reactions can be up to 5 words.");
    return;
  }
  sendReaction(reaction);
  els.customReactionInput.value = "";
}

function sendReaction(value) {
  const reaction = normalizeReaction(value);
  if (!reaction) return;
  send({ type: "reaction", emoji: reaction });
}

function sendSettings() {
  if (!state.isHost) return;
  send({
    type: "settings:update",
    settings: {
      hostOnlyControls: els.hostOnlyToggle.checked,
      chatEnabled: els.chatToggle.checked,
      voiceEnabled: els.voiceToggle.checked,
      videoEnabled: els.videoToggle.checked
    }
  });
}

function sendPlayback(force) {
  if (!state.room || state.room.mode !== "direct-sync") return;
  if (sourceKind(state.room.source?.url) !== "video") {
    toast("Embedded players can load together, but this site cannot control their play/pause sync.");
    return;
  }
  const now = Date.now();
  if (!force && now - state.lastPlaybackSentAt < 900) return;
  state.lastPlaybackSentAt = now;
  send({
    type: "playback",
    state: els.watchVideo.paused ? "paused" : "playing",
    currentTime: els.watchVideo.currentTime || 0,
    duration: Number.isFinite(els.watchVideo.duration) ? els.watchVideo.duration : 0,
    rate: els.watchVideo.playbackRate || 1
  });
}

async function applyPlayback(playback, from) {
  if (!playback || from === state.clientId || state.room?.mode !== "direct-sync") return;
  if (sourceKind(state.room.source?.url) !== "video") return;
  if (!els.watchVideo.src) return;

  const targetTime = playback.currentTime + (playback.state === "playing" ? (Date.now() - playback.updatedAt) / 1000 : 0);
  const drift = Math.abs((els.watchVideo.currentTime || 0) - targetTime);
  const tolerance = state.room?.settings?.driftTolerance || 0.85;

  state.suppressPlayback = true;
  els.watchVideo.playbackRate = playback.rate || 1;
  if (drift > tolerance) {
    els.watchVideo.currentTime = Math.max(0, targetTime);
    setSyncStatus(`Adjusted ${drift.toFixed(1)}s`, "warn");
  } else {
    setSyncStatus("Synced", "good");
  }

  if (playback.state === "playing" && els.watchVideo.paused) {
    try {
      await els.watchVideo.play();
    } catch {
      toast("Click play once so the browser allows synced playback.");
    }
  } else if (playback.state !== "playing" && !els.watchVideo.paused) {
    els.watchVideo.pause();
  }

  setTimeout(() => {
    state.suppressPlayback = false;
  }, 250);
}

async function toggleMedia(kind) {
  if (!state.room) return;
  if (kind === "audio" && !state.room.settings.voiceEnabled) return;
  if (kind === "video" && !state.room.settings.videoEnabled) return;

  if (mediaEnabled(kind)) {
    stopMedia(kind);
    return;
  }

  try {
    await startMedia(kind);
  } catch {
    toast(`${kind === "audio" ? "Microphone" : "Camera"} permission was blocked.`);
    return;
  }

  updateMediaButtons();
  notifyMediaState();
  await createOffersForParticipants();
}

async function createOffersForParticipants() {
  if (!hasLocalMedia()) return;
  for (const person of state.knownParticipants.values()) {
    if (person.id !== state.clientId) {
      await createOffer(person.id);
    }
  }
}

function handleNewParticipants(participants) {
  if (!hasLocalMedia()) return;
  participants.forEach((person) => {
    if (person.id !== state.clientId && !state.peers.has(person.id)) {
      setTimeout(() => createOffer(person.id), 250);
    }
  });
}

async function createOffer(peerId) {
  const pc = ensurePeer(peerId);
  if (pc.signalingState !== "stable") return;
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send({ type: "signal", to: peerId, signal: pc.localDescription });
}

async function handleSignal(peerId, signal) {
  const pc = ensurePeer(peerId);
  if (signal.type === "offer") {
    await pc.setRemoteDescription(signal);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send({ type: "signal", to: peerId, signal: pc.localDescription });
    return;
  }

  if (signal.type === "answer") {
    await pc.setRemoteDescription(signal);
    return;
  }

  if (signal.candidate) {
    try {
      await pc.addIceCandidate(signal);
    } catch {}
  }
}

function ensurePeer(peerId) {
  if (state.peers.has(peerId)) return state.peers.get(peerId);

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });

  if (state.localStream) {
    activeLocalTracks().forEach((track) => pc.addTrack(track, state.localStream));
  }

  pc.addEventListener("icecandidate", (event) => {
    if (event.candidate) {
      send({ type: "signal", to: peerId, signal: event.candidate });
    }
  });

  pc.addEventListener("track", (event) => {
    const [stream] = event.streams;
    if (!stream) return;
    let video = document.querySelector(`[data-peer-video="${peerId}"]`);
    if (!video) {
      video = document.createElement("video");
      video.dataset.peerVideo = peerId;
      video.autoplay = true;
      video.playsInline = true;
      els.remoteGrid.append(video);
    }
    video.srcObject = stream;
  });

  pc.addEventListener("connectionstatechange", () => {
    if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
      closePeer(peerId);
    }
  });

  state.peers.set(peerId, pc);
  return pc;
}

function closePeer(peerId) {
  const pc = state.peers.get(peerId);
  if (pc) pc.close();
  state.peers.delete(peerId);
  document.querySelector(`[data-peer-video="${peerId}"]`)?.remove();
}

async function startMedia(kind) {
  const stream = await navigator.mediaDevices.getUserMedia(kind === "audio" ? { audio: true } : { video: true });
  const [track] = kind === "audio" ? stream.getAudioTracks() : stream.getVideoTracks();
  if (!track) throw new Error("No media track returned");
  attachLocalTrack(track);
  addTrackToPeers(track);
  updateLocalPreview();
}

function attachLocalTrack(track) {
  stopMedia(track.kind, false);
  ensureLocalStream();
  state.localStream.addTrack(track);
  track.addEventListener("ended", () => {
    state.localStream?.removeTrack(track);
    removeTrackFromPeers(track);
    cleanupLocalStream();
    updateMediaButtons();
    updateLocalPreview();
    notifyMediaState();
    renegotiatePeers();
  });
}

function stopMedia(kind, shouldNotify = true) {
  activeLocalTracks(kind).forEach((track) => {
    removeTrackFromPeers(track);
    state.localStream?.removeTrack(track);
    track.stop();
  });
  cleanupLocalStream();
  updateMediaButtons();
  updateLocalPreview();
  if (shouldNotify) {
    notifyMediaState();
    renegotiatePeers();
  }
}

function ensureLocalStream() {
  if (!state.localStream) state.localStream = new MediaStream();
}

function cleanupLocalStream() {
  if (state.localStream && state.localStream.getTracks().length === 0) {
    state.localStream = null;
  }
}

function addTrackToPeers(track) {
  for (const pc of state.peers.values()) {
    const alreadySending = pc.getSenders().some((sender) => sender.track === track);
    if (!alreadySending && state.localStream) pc.addTrack(track, state.localStream);
  }
}

function removeTrackFromPeers(track) {
  for (const pc of state.peers.values()) {
    pc.getSenders()
      .filter((sender) => sender.track === track)
      .forEach((sender) => pc.removeTrack(sender));
  }
}

async function renegotiatePeers() {
  for (const [peerId, pc] of state.peers.entries()) {
    if (pc.connectionState !== "closed" && pc.signalingState === "stable") {
      await createOffer(peerId);
    }
  }
}

function updateLocalPreview() {
  const showPreview = mediaEnabled("video") && state.localStream;
  els.localPreviewWrap.classList.toggle("hidden", !showPreview);
  els.localPreview.srcObject = showPreview ? state.localStream : null;
}

function updateMediaButtons() {
  els.toggleMic.textContent = mediaEnabled("audio") ? "Mic on" : "Mic off";
  els.toggleCamera.textContent = mediaEnabled("video") ? "Camera on" : "Camera off";
  els.toggleMic.classList.toggle("active", mediaEnabled("audio"));
  els.toggleCamera.classList.toggle("active", mediaEnabled("video"));
}

function notifyMediaState() {
  send({ type: "media-state", audio: mediaEnabled("audio"), video: mediaEnabled("video") });
}

function hasLocalMedia() {
  return activeLocalTracks().length > 0;
}

function mediaEnabled(kind) {
  return activeLocalTracks(kind).length > 0;
}

function activeLocalTracks(kind) {
  if (!state.localStream) return [];
  return state.localStream.getTracks().filter((track) => {
    const kindMatches = kind ? track.kind === kind : true;
    return kindMatches && track.readyState === "live";
  });
}

function canControlPlayback() {
  if (!state.room) return false;
  return state.isHost || !state.room.settings.hostOnlyControls;
}

function sourceKind(url) {
  if (!url) return "empty";
  let pathname = "";
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return "embed";
  }
  return /\.(mp4|webm|ogg|ogv|mov)$/i.test(pathname) ? "video" : "embed";
}

function leaveCurrentRoom() {
  if (state.room) send({ type: "leave" });
  showLobby();
}

function showRoom() {
  els.lobbyView.classList.add("hidden");
  els.roomView.classList.remove("hidden");
}

function showLobby() {
  stopAllMedia();
  closeAllPeers();
  state.room = null;
  state.isHost = false;
  state.knownParticipants = new Map();
  history.replaceState(null, "", "/");
  els.roomView.classList.add("hidden");
  els.lobbyView.classList.remove("hidden");
  els.watchVideo.pause();
  els.watchVideo.removeAttribute("src");
  els.watchVideo.load();
  els.watchEmbed.removeAttribute("src");
  els.chatLog.replaceChildren();
  els.participants.replaceChildren();
  els.participantCount.textContent = "0";
  els.sourceInput.value = "";
  els.customReactionInput.value = "";
  setSyncStatus("Synced", "good");
  completeBoot("Ready");
}

function stopAllMedia() {
  stopMedia("audio", false);
  stopMedia("video", false);
}

function closeAllPeers() {
  for (const peerId of [...state.peers.keys()]) {
    closePeer(peerId);
  }
}

async function copyInvite() {
  if (!state.room) return;
  const invite = `${location.origin}/?room=${state.room.code}`;
  try {
    await navigator.clipboard.writeText(invite);
    toast("Invite copied.");
  } catch {
    toast(`Room code: ${state.room.code}`);
  }
}

function showReaction(reaction) {
  const node = document.createElement("div");
  node.className = "floating-reaction";
  node.textContent = reaction.emoji;
  els.videoFrame.append(node);
  setTimeout(() => node.remove(), 1600);
}

function send(payload) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(payload));
  } else {
    toast("Connecting. Try again in a moment.");
  }
}

function setConnection(online) {
  els.lobbyConnection.textContent = online ? "Online" : "Offline";
  els.lobbyConnection.classList.toggle("online", online);
  els.lobbyConnection.classList.toggle("warn", !online);
}

function setBootStatus(text) {
  if (els.bootStatus && !state.bootDone) {
    els.bootStatus.textContent = text;
  }
}

function completeBoot(text) {
  if (state.bootDone) return;
  setBootStatus(text);
  state.bootDone = true;
  const elapsed = performance.now() - state.bootStartedAt;
  const delay = Math.max(0, 1550 - elapsed);
  setTimeout(() => {
    document.body.classList.add("app-ready");
    els.bootScreen?.setAttribute("aria-hidden", "true");
  }, delay);
}

function setSyncStatus(text, tone) {
  els.syncStatus.textContent = text;
  els.syncStatus.className = tone || "";
}

function toast(text) {
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = text;
  els.toastArea.append(node);
  setTimeout(() => node.remove(), 3600);
}

function prefillNames() {
  document.querySelectorAll('input[name="name"]').forEach((input) => {
    input.value = state.name;
  });
}

function persistName(name) {
  state.name = name;
  localStorage.setItem("watchName", name);
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeBackendUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (!/^https?:\/\//i.test(text)) return "";
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    const basePath = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${basePath}`;
  } catch {
    return "";
  }
}

function apiUrl(pathname) {
  return backendUrl ? `${backendUrl}${pathname}` : pathname;
}

function websocketUrl(pathname) {
  if (backendUrl) {
    const url = new URL(`${backendUrl}${pathname}`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  const protocol = location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${location.host}${pathname}`;
}

function normalizeReaction(value) {
  const words = clean(value).split(" ").filter(Boolean);
  if (words.length === 0 || words.length > 5) return "";
  return words.join(" ");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
