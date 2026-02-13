// ============================
// グローバル変数 & 設定
// ============================
let socket = null, myPeer = null, myStream = null;
let users = {}, activeCalls = {}; // PeerID: MediaConnection
let myId = null;

// 画面共有
let myScreenStream = null;
let isScreenSharing = false;
let myCombinedStream = null;
let remoteScreenSharerId = null;

// YouTube
let youtubePlayer = null;
let currentYoutubeState = { roomId: null, videoId: null, isPlaying: false, timestamp: 0, isRepeat: false };

// 基本設定
let myX = 1400, myY = 900; 
let myName = "ゲスト";
let myRoomId = null; 
let isMicMutedByUser = true;
let audioContext = null; 
let currentSpeakerId = "";

// BGM
let bgmSourceNode = null, bgmGainNode = null;
const bgmAudio = new Audio();
bgmAudio.loop = true; 
bgmAudio.crossOrigin = "anonymous";

// タイマー
let timerInterval = null, timerTime = 15 * 60, isFocusMode = true, isTimerRunning = false;

// 表示
let cameraScale = 1.0;
const MIN_ZOOM = 0.4, MAX_ZOOM = 2.0; 
const bgImage = new Image(); bgImage.src = "bg.jpg"; 

const WORLD_W = 2000, WORLD_H = 1125;
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
const TALK_DISTANCE = 120, DISCONNECT_DISTANCE = 150; 

const MEETING_ROOMS = [
    { id: 'A', name: '大会議室', type: 'rect', x: 40, y: 180, w: 680, h: 800, capacity: 10 },
    { id: 'B', name: 'ソファ席', type: 'rect', x: 820, y: 550, w: 420, h: 450, capacity: 6 }
];
const ZONES = {
    SILENT: { name: "集中ブース", check: (x,y) => (x > 750 && x < 1450 && y < 450), allowMic: false },
    LIVING: { name: "コミュニティ", check: (x,y) => true, allowMic: true }
};

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const micBtn = document.getElementById('micBtn');

// ============================
// 1. 初期化
// ============================
window.addEventListener('load', () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    
    if (isMobile) {
        if(document.getElementById('d-pad')) document.getElementById('d-pad').style.display = 'block';
    } else {
        const ssBtn = document.getElementById('screenShareBtn');
        if(ssBtn) ssBtn.style.display = 'none';
    }

    const bgmSelect = document.getElementById('bgmSelect');
    if(bgmSelect) bgmSelect.addEventListener('change', changeBgm);

    const bgmVolume = document.getElementById('bgmVolume');
    if(bgmVolume) {
        bgmVolume.addEventListener('input', (e) => {
            if(bgmGainNode) bgmGainNode.gain.value = parseFloat(e.target.value);
        });
    }
    
    const ytVolume = document.getElementById('ytVolume');
    if(ytVolume) {
        ytVolume.addEventListener('input', (e) => {
            if(youtubePlayer && youtubePlayer.setVolume) {
                youtubePlayer.setVolume(parseInt(e.target.value));
            }
        });
    }

    document.addEventListener('visibilitychange', () => { 
        if (document.visibilityState === 'visible') ensureAudioContext(); 
    });
    document.body.addEventListener('click', ensureAudioContext, {once: false});
    document.body.addEventListener('touchstart', ensureAudioContext, {once: false, passive: true});
});

function ensureAudioContext() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!audioContext) audioContext = new AC();
    if (audioContext.state === 'suspended') audioContext.resume().catch(e=>{});

    if (!bgmSourceNode) {
        try {
            bgmSourceNode = audioContext.createMediaElementSource(bgmAudio);
            bgmGainNode = audioContext.createGain();
            const volInput = document.getElementById('bgmVolume');
            if(volInput) bgmGainNode.gain.value = parseFloat(volInput.value);
            bgmSourceNode.connect(bgmGainNode);
            bgmGainNode.connect(audioContext.destination);
        } catch(e) {}
    }
    return audioContext;
}

// YouTube API
function loadYoutubeApi() {
    if (window.YT) return;
    const tag = document.createElement('script');
    tag.src = "https://www.youtube.com/iframe_api";
    const firstScriptTag = document.getElementsByTagName('script')[0];
    firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
}

window.onYouTubeIframeAPIReady = function() {
    youtubePlayer = new YT.Player('player', {
        height: '1', width: '1',
        playerVars: { 'playsinline': 1, 'controls': 0, 'disablekb': 1 },
        events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
    });
};

function onPlayerReady() { checkYoutubeStatus(); }

function onPlayerStateChange(event) {
    if (event.data === YT.PlayerState.ENDED) {
        if (currentYoutubeState.isRepeat && myRoomId === currentYoutubeState.roomId) {
            currentYoutubeState.timestamp = Date.now();
            currentYoutubeState.isPlaying = true;
            socket.emit('changeYoutube', currentYoutubeState);
        }
    }
}

async function startSetup() {
    ensureAudioContext();
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
        await getDevices('micSelect', 'speakerSelect');
        document.getElementById('start-overlay').style.display = 'none';
        document.getElementById('entry-modal').style.display = 'flex';
        const micSelect = document.getElementById('micSelect');
        if(micSelect) {
            micSelect.addEventListener('change', () => startMicTest('micSelect', 'mic-visualizer-bar-entry'));
            startMicTest('micSelect', 'mic-visualizer-bar-entry');
        }
    } catch (err) { alert("マイクの使用を許可してください。"); }
}

// ============================
// 2. 入室処理
// ============================
document.getElementById('enterGameBtn').addEventListener('click', async () => {
    const nameInput = document.getElementById('username');
    if (!nameInput.value) { alert("名前を入力してください"); return; }
    myName = nameInput.value;
    document.getElementById('entry-modal').style.display = 'none';
    ensureAudioContext();

    const micId = document.getElementById('micSelect').value;
    currentSpeakerId = document.getElementById('speakerSelect').value;

    const constraints = { audio: { deviceId: micId ? { exact: micId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true } };

    navigator.mediaDevices.getUserMedia(constraints)
    .then(stream => { myStream = stream; setMicState(false); startSocketConnection(); })
    .catch(err => alert("マイクエラー: " + err));
});

function startSocketConnection() {
    socket = io();
    socket.on('connect', () => { myId = socket.id; });
    socket.on('updateUsers', (data) => { users = data; updateVolumes(); });
    socket.on('youtubeSync', (data) => {
        if (data.roomId === myRoomId) {
            currentYoutubeState = data;
            checkYoutubeStatus();
        }
    });

    // ★画面共有の同期 (受信側)
    socket.on('screenShareSync', (data) => {
        if (data.roomId === myRoomId) {
            
            // 共有者が変わった、または終了した場合
            if (data.sharerId !== remoteScreenSharerId) {
                
                // 1. まず表示を消す
                closeScreenShareWindow();
                
                // 2. 以前の共有者との接続を強制切断 (これが重要)
                if (remoteScreenSharerId && activeCalls[remoteScreenSharerId]) {
                    activeCalls[remoteScreenSharerId].close();
                    delete activeCalls[remoteScreenSharerId];
                }
                
                // 3. もし自分が共有中だったのに、他人が共有権を取った場合、自分を止める
                if (isScreenSharing && data.sharerId && data.sharerId !== myId) {
                    stopScreenShare(false); // 通知せずに停止
                }

                // 4. ID更新
                remoteScreenSharerId = data.sharerId;
                
                // 5. 新しい共有者との接続は manageConnections が行う
            }
        }
    });

    myPeer = new Peer();
    myPeer.on('open', peerId => socket.emit('enterRoom', { name: myName, peerId: peerId }));
    
    myPeer.on('call', call => {
        // 重複接続の防止
        if (activeCalls[call.peer]) {
            activeCalls[call.peer].close();
            delete activeCalls[call.peer];
        }

        const streamToSend = (isScreenSharing && myCombinedStream) ? myCombinedStream : myStream;
        call.answer(streamToSend);
        setupCallEvents(call);
        activeCalls[call.peer] = call;
    });

    setInterval(manageConnections, 1000);
    setInterval(updateVolumes, 500);
    loop();
}

// ============================
// 3. 画面共有 (修正版)
// ============================
async function toggleScreenShare() {
    if (!myRoomId) { alert("画面共有は会議室の中でのみ使用できます"); return; }

    if (isScreenSharing) {
        stopScreenShare(true);
    } else {
        try {
            const withAudio = document.getElementById('ssAudioCheck').checked;
            
            myScreenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: withAudio });
            
            const videoTrack = myScreenStream.getVideoTracks()[0];
            const micTrack = myStream.getAudioTracks()[0];
            
            // シンプルなトラック結合 (スマホ互換性重視)
            let tracks = [videoTrack, micTrack];
            if (withAudio && myScreenStream.getAudioTracks().length > 0) {
                tracks.push(myScreenStream.getAudioTracks()[0]);
            }
            myCombinedStream = new MediaStream(tracks);

            videoTrack.onended = () => stopScreenShare(true);

            isScreenSharing = true;
            const btn = document.getElementById('screenShareBtn');
            if(btn) { btn.innerText = "📺 共有停止"; btn.style.background = "#e74c3c"; }

            // サーバーへ開始を通知
            socket.emit('updateScreenShare', { roomId: myRoomId, isSharing: true });

            reconnectEveryone();

        } catch (err) {
            console.error(err);
            isScreenSharing = false;
        }
    }
}

function stopScreenShare(notifyServer) {
    if (myScreenStream) {
        myScreenStream.getTracks().forEach(t => t.stop());
        myScreenStream = null;
    }
    myCombinedStream = null;
    isScreenSharing = false;
    
    const btn = document.getElementById('screenShareBtn');
    if(btn) { btn.innerText = "📺 画面共有"; btn.style.background = "#3498db"; }
    
    if(notifyServer && myRoomId) {
        socket.emit('updateScreenShare', { roomId: myRoomId, isSharing: false });
    }

    reconnectEveryone();
}

function reconnectEveryone() {
    Object.values(activeCalls).forEach(call => call.close());
    activeCalls = {};
}

function toggleScreenSize() {
    const container = document.getElementById('screen-share-container');
    if(container.classList.contains('small')) {
        container.classList.remove('small'); container.classList.add('large');
    } else {
        container.classList.remove('large'); container.classList.add('small');
    }
}

function closeScreenShareWindow() {
    const videoEl = document.getElementById('screen-share-video');
    const container = document.getElementById('screen-share-container');
    container.style.display = 'none';
    if(videoEl) {
        videoEl.srcObject = null;
        videoEl.load();
    }
    // remoteScreenSharerId は socketイベントで制御するためここでは消さない
}

// ============================
// 4. YouTube
// ============================
function startYoutube() {
    if (!myRoomId) { alert("YouTube共有は会議室でのみ利用可能です"); return; }
    
    const url = document.getElementById('ytUrl').value;
    let videoId = null;
    try {
        const urlObj = new URL(url);
        if(urlObj.hostname.includes('youtube.com')) videoId = urlObj.searchParams.get('v');
        else if(urlObj.hostname.includes('youtu.be')) videoId = urlObj.pathname.slice(1);
    } catch(e) {}

    if(!videoId) { alert("正しいURLを入力してください"); return; }
    
    currentYoutubeState.roomId = myRoomId;
    currentYoutubeState.videoId = videoId;
    currentYoutubeState.isPlaying = true;
    currentYoutubeState.timestamp = Date.now();
    
    socket.emit('changeYoutube', currentYoutubeState);
    document.getElementById('youtube-modal').style.display = 'none';
    checkYoutubeStatus();
}

function stopYoutube() {
    currentYoutubeState.isPlaying = false;
    socket.emit('changeYoutube', currentYoutubeState);
    document.getElementById('youtube-modal').style.display = 'none';
    checkYoutubeStatus();
}

function toggleYoutubeRepeat() {
    currentYoutubeState.isRepeat = !currentYoutubeState.isRepeat;
    const btn = document.getElementById('ytRepeatBtn');
    if (currentYoutubeState.isRepeat) {
        btn.innerText = "🔁 リピートON"; btn.className = "btn btn-green";
    } else {
        btn.innerText = "🔁 リピートOFF"; btn.className = "btn btn-gray";
    }
    if (myRoomId) {
        currentYoutubeState.roomId = myRoomId;
        socket.emit('changeYoutube', currentYoutubeState);
    }
}

function checkYoutubeStatus() {
    if (!youtubePlayer || !youtubePlayer.loadVideoById) return;

    const myZone = getCurrentZone();
    const shouldPlay = currentYoutubeState.isPlaying && 
                       (currentYoutubeState.roomId === myRoomId) && 
                       !isTimerRunning;

    if (shouldPlay) {
        const pState = youtubePlayer.getPlayerState();
        if (youtubePlayer.getVideoData().video_id !== currentYoutubeState.videoId) {
            youtubePlayer.loadVideoById(currentYoutubeState.videoId);
        } else if (pState !== 1 && pState !== 3) {
            youtubePlayer.playVideo();
        }
        const vol = document.getElementById('ytVolume').value;
        youtubePlayer.setVolume(parseInt(vol));
    } else {
        youtubePlayer.pauseVideo();
    }
}

// ============================
// 5. 接続管理 (Connection)
// ============================
function manageConnections() {
    if (!myPeer || !myStream || !myId) return;
    const myZone = getCurrentZone();

    Object.keys(users).forEach(targetId => {
        if (targetId === myId) return;
        const u = users[targetId];
        if (!u.peerId) return;

        let shouldConnect = false;
        if (myRoomId) {
            if (u.roomId === myRoomId) shouldConnect = true; 
        } else {
            if (!u.roomId) {
                const dist = Math.sqrt((myX - u.x)**2 + (myY - u.y)**2);
                const uZoneIsSilent = ZONES.SILENT.check(u.x, u.y);
                if (myZone.allowMic && !uZoneIsSilent) {
                    if (dist <= TALK_DISTANCE) shouldConnect = true;
                    else if (dist <= DISCONNECT_DISTANCE && activeCalls[u.peerId]) shouldConnect = true;
                }
            }
        }

        if (shouldConnect) {
            if (!activeCalls[u.peerId]) {
                if (myPeer.id > u.peerId) {
                    const streamToSend = (isScreenSharing && myCombinedStream) ? myCombinedStream : myStream;
                    console.log("発信:", u.name);
                    const call = myPeer.call(u.peerId, streamToSend);
                    setupCallEvents(call);
                    activeCalls[u.peerId] = call;
                }
            }
        } else {
            if (activeCalls[u.peerId]) {
                console.log("切断:", u.name);
                activeCalls[u.peerId].close();
                delete activeCalls[u.peerId];
                removeMediaElements(u.peerId);
            }
        }
    });

    Object.keys(activeCalls).forEach(peerId => {
        const isUserExists = Object.values(users).some(u => u.peerId === peerId);
        if (!isUserExists) {
            activeCalls[peerId].close();
            delete activeCalls[peerId];
            removeMediaElements(peerId);
        }
    });
}

function setupCallEvents(call) {
    call.on('stream', remoteStream => {
        // ★映像トラックがあれば画面共有
        if (remoteStream.getVideoTracks().length > 0) {
            const container = document.getElementById('screen-share-container');
            const videoEl = document.getElementById('screen-share-video');
            
            if (videoEl) {
                videoEl.srcObject = remoteStream;
                container.style.display = 'block';
                videoEl.play().catch(e => console.log("Play error:", e));
            }
        } else {
            // ★音声のみ (Video+Audio共有の Audio もここで処理される可能性があるが、Videoタグで賄えるならそちら優先)
            // 重複しないようにチェック
            if (document.getElementById("audio-" + call.peer)) return;
            
            const audio = document.createElement('audio');
            audio.id = "audio-" + call.peer;
            audio.srcObject = remoteStream;
            audio.autoplay = true; 
            audio.playsInline = true;
            if(currentSpeakerId && audio.setSinkId) audio.setSinkId(currentSpeakerId).catch(e=>{});
            audio.volume = 0; 
            audio.muted = true;
            document.body.appendChild(audio);
        }
    });

    const cleanup = () => { 
        removeMediaElements(call.peer); 
        if (activeCalls[call.peer]) delete activeCalls[call.peer]; 
    };
    call.on('close', cleanup);
    call.on('error', cleanup);
}

function removeMediaElements(peerId) {
    const el = document.getElementById("audio-" + peerId);
    if (el) el.remove();
    
    // もしその人が画面共有者だったら閉じる
    if (remoteScreenSharerId === peerId) {
        closeScreenShareWindow();
    }
}

function updateVolumes() {
    Object.keys(users).forEach(targetId => {
        if (targetId === myId) return;
        const u = users[targetId];
        if (!u.peerId) return;
        
        let volume = 0;
        if (myRoomId) {
            if (u.roomId === myRoomId) volume = 1.0;
        } else {
            if (!u.roomId) {
                const dist = Math.sqrt((myX - u.x)**2 + (myY - u.y)**2);
                if (dist <= TALK_DISTANCE) volume = 1.0;
                else volume = 0;
            }
        }

        const audioEl = document.getElementById("audio-" + u.peerId);
        if (audioEl) {
            if (volume <= 0.01) audioEl.muted = true;
            else { audioEl.muted = false; audioEl.volume = volume; }
        }
        
        // 画面共有者のビデオ音声も制御
        if (remoteScreenSharerId === u.peerId) {
            const videoEl = document.getElementById('screen-share-video');
            if(videoEl) {
                // スマホはmutedでないと再生されない場合があるため、表示時は音声をaudioタグに任せる手もあるが、
                // 結合ストリームの場合はvideoタグから音が出る
                if(volume <= 0.01) videoEl.muted = true;
                else { videoEl.muted = false; videoEl.volume = volume; }
            }
        }
    });
}

// ============================
// 6. 操作・移動
// ============================
canvas.addEventListener('click', (e) => {
    if (myRoomId) return;
    const pos = getWorldPos(e.clientX, e.clientY);
    const room = MEETING_ROOMS.find(r => pos.x >= r.x && pos.x <= r.x+r.w && pos.y >= r.y && pos.y <= r.y+r.h);
    if (room) showRoomModal(room);
});

canvas.addEventListener('dblclick', (e) => {
    if (myRoomId) return;
    const pos = getWorldPos(e.clientX, e.clientY);
    const room = MEETING_ROOMS.find(r => pos.x >= r.x && pos.x <= r.x+r.w && pos.y >= r.y && pos.y <= r.y+r.h);
    if (!room) moveMe(pos.x, pos.y);
});

window.addEventListener('keydown', (e) => {
    if (myRoomId || document.activeElement.tagName === 'INPUT') return;
    const speed = 20; 
    let nextX = myX, nextY = myY, moved = false;
    switch(e.key) {
        case 'ArrowUp': nextY -= speed; moved = true; break;
        case 'ArrowDown': nextY += speed; moved = true; break;
        case 'ArrowLeft': nextX -= speed; moved = true; break;
        case 'ArrowRight': nextX += speed; moved = true; break;
    }
    if (moved) { e.preventDefault(); moveMe(nextX, nextY); }
});

const setupBtn = (id, dx, dy) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    let interval = null; const speed = 20;
    const startMove = (e) => {
        if(e.cancelable) e.preventDefault(); if(myRoomId) return;
        if(!interval) {
            interval = setInterval(() => {
                let nextX = myX + dx * speed; let nextY = myY + dy * speed;
                nextX = Math.max(20, Math.min(nextX, WORLD_W-20));
                nextY = Math.max(20, Math.min(nextY, WORLD_H-20));
                myX = nextX; myY = nextY; moveMe(myX, myY); 
            }, 50);
        }
    };
    const stopMove = (e) => { if(e.cancelable) e.preventDefault(); clearInterval(interval); interval = null; };
    btn.addEventListener('touchstart', startMove, { passive: false });
    btn.addEventListener('touchend', stopMove, { passive: false });
    btn.addEventListener('mousedown', startMove);
    window.addEventListener('mouseup', stopMove);
};
setupBtn('d-up', 0, -1); setupBtn('d-down', 0, 1); setupBtn('d-left', -1, 0); setupBtn('d-right', 1, 0);

let lastMoveTime = 0;
function moveMe(x, y) {
    myX = Math.max(20, Math.min(x, WORLD_W-20));
    myY = Math.max(20, Math.min(y, WORLD_H-20));
    const now = Date.now();
    if (socket && (now - lastMoveTime > 50)) {
        socket.emit('move', { x: myX, y: myY, roomId: myRoomId });
        lastMoveTime = now;
    }
    checkAudioStatus(); 
    checkYoutubeStatus();
}

function getCurrentZone() { if (ZONES.SILENT.check(myX, myY)) return ZONES.SILENT; return ZONES.LIVING; }

function checkAudioStatus() {
    const currentZone = getCurrentZone();
    let canSpeak = false; let statusText = "";
    if (myRoomId) { canSpeak = true; statusText = "会議中"; }
    else {
        if (!currentZone.allowMic) { canSpeak = false; statusText = "会話禁止エリア"; }
        else { canSpeak = true; statusText = "会話OK"; }
    }
    updateMicBtn(canSpeak, statusText);
    setMicState(canSpeak && !isMicMutedByUser);
    updateVolumes();
}

function updateMicBtn(enabled, text) {
    if (!enabled) { micBtn.disabled = true; micBtn.innerText = text; micBtn.style.background = "#555"; }
    else { micBtn.disabled = false; micBtn.innerText = isMicMutedByUser ? "マイクOFF" : "マイクON"; micBtn.style.background = isMicMutedByUser ? "#e74c3c" : "#27ae60"; }
}

function toggleMic() { isMicMutedByUser = !isMicMutedByUser; checkAudioStatus(); }
function setMicState(isOn) { if (myStream && myStream.getAudioTracks()[0]) myStream.getAudioTracks()[0].enabled = isOn; }
function exitOffice() { if(confirm("退出しますか？")) location.reload(); }

// ============================
// 7. モーダル制御
// ============================
function showRoomModal(room) {
    const count = Object.values(users).filter(u => u.roomId === room.id).length;
    if (count >= room.capacity) { alert("満員です"); return; }
    document.getElementById('room-title').innerText = room.name;
    document.getElementById('room-info').innerText = `定員: ${count}/${room.capacity}`;
    document.getElementById('room-modal').style.display = 'flex';
    const joinBtn = document.getElementById('joinRoomBtn');
    const newBtn = joinBtn.cloneNode(true);
    joinBtn.parentNode.replaceChild(newBtn, joinBtn);
    newBtn.onclick = async () => {
        ensureAudioContext(); myRoomId = room.id;
        loadYoutubeApi();

        myX = room.x + room.w/2 - 50 + Math.random()*100;
        myY = room.y + room.h/2 - 50 + Math.random()*100;
        socket.emit('move', { x: myX, y: myY, roomId: myRoomId });
        document.getElementById('room-modal').style.display = 'none';
        document.getElementById('leaveRoomBtn').style.display = 'block';
        document.getElementById('room-status').style.display = 'block';
        
        document.getElementById('ytBtn').style.display = 'flex';

        if(!isMobile) {
            document.getElementById('screenShareBtn').style.display = 'block';
            document.getElementById('ss-options').style.display = 'flex';
        }
        if(myStream) myStream.getAudioTracks().forEach(t => t.enabled = true);
        checkAudioStatus(); manageConnections(); checkYoutubeStatus();
    };
}

function closeRoomModal() { document.getElementById('room-modal').style.display = 'none'; }

function leaveMeetingRoom() {
    if(isScreenSharing) stopScreenShare(true);
    myRoomId = null;
    moveMe(1300, 900);
    document.getElementById('leaveRoomBtn').style.display = 'none';
    document.getElementById('room-status').style.display = 'none';
    document.getElementById('screenShareBtn').style.display = 'none';
    document.getElementById('ss-options').style.display = 'none';
    
    closeScreenShareWindow();
    
    document.getElementById('ytBtn').style.display = 'none';
    if(youtubePlayer && youtubePlayer.pauseVideo) youtubePlayer.pauseVideo();

    checkAudioStatus(); manageConnections(); checkYoutubeStatus();
}

function openTimer() { document.getElementById('timer-modal').style.display = 'flex'; }
function closeTimer() { document.getElementById('timer-modal').style.display = 'none'; }

function toggleTimer() {
    const btn = document.getElementById('timerStartBtn');
    if (isTimerRunning) { clearInterval(timerInterval); isTimerRunning = false; bgmAudio.pause(); btn.innerText = "再開"; btn.className = "btn btn-green"; }
    else { timerInterval = setInterval(updateTimer, 1000); isTimerRunning = true; playCurrentBgm(); btn.innerText = "一時停止"; btn.className = "btn btn-orange"; }
    checkYoutubeStatus();
}

function resetTimer() {
    clearInterval(timerInterval); isTimerRunning = false; isFocusMode = true; timerTime = 15 * 60; bgmAudio.pause(); bgmAudio.currentTime = 0;
    updateTimerDisplay(); document.getElementById('timerStartBtn').innerText = "スタート"; document.getElementById('timerStartBtn').className = "btn btn-green";
    document.getElementById('timer-status-text').innerText = "集中タイム (15分)"; document.getElementById('timer-status-text').style.color = "#e67e22"; checkYoutubeStatus();
}

function updateTimer() { timerTime--; if (timerTime < 0) switchMode(); updateTimerDisplay(); }
function switchMode() { isFocusMode = !isFocusMode; if (isFocusMode) { timerTime = 15 * 60; document.getElementById('timer-status-text').innerText = "集中タイム (15分)"; document.getElementById('timer-status-text').style.color = "#e67e22"; } else { timerTime = 5 * 60; document.getElementById('timer-status-text').innerText = "休憩タイム (5分)"; document.getElementById('timer-status-text').style.color = "#27ae60"; } playCurrentBgm(); }
function updateTimerDisplay() { const m = Math.floor(timerTime / 60).toString().padStart(2, '0'); const s = (timerTime % 60).toString().padStart(2, '0'); document.getElementById('timer-display').innerText = `${m}:${s}`; }
function changeBgm() { if (isTimerRunning) playCurrentBgm(); }

function playCurrentBgm() {
    let src = "";
    if (!isFocusMode) src = "bgm_break.mp3";
    else {
        const val = document.getElementById('bgmSelect').value;
        if (val === "focus1") src = "bgm_focus1.mp3"; else if (val === "focus2") src = "bgm_focus2.mp3"; else if (val === "focus3") src = "bgm_focus3.mp3"; else src = "";
    }
    if (src) {
        ensureAudioContext();
        if (!bgmAudio.src.includes(src)) { bgmAudio.src = src; bgmAudio.load(); }
        if(bgmGainNode) try{}catch(e){}
        if(currentSpeakerId && bgmAudio.setSinkId) bgmAudio.setSinkId(currentSpeakerId).catch(e=>{});
        bgmAudio.play().catch(e=>{});
    } else { bgmAudio.pause(); }
}

// ============================
// 8. ユーティリティ & デバイス設定
// ============================
async function getDevices(mId, sId) {
    try {
        const d = await navigator.mediaDevices.enumerateDevices();
        const m = document.getElementById(mId), s = document.getElementById(sId);
        m.innerHTML = ''; s.innerHTML = '';
        d.forEach(v => {
            const o = document.createElement('option'); o.value = v.deviceId; o.text = v.label || v.kind;
            if(v.kind==='audioinput') m.appendChild(o);
            if(v.kind==='audiooutput') s.appendChild(o);
        });
    } catch(e){}
}

function startMicTest(selectId, barId) {
    const micId = document.getElementById(selectId).value;
    if (!micId) return;
    
    const ctx = ensureAudioContext();
    if (!ctx) return;

    navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: micId } } })
    .then(s => {
        const src = ctx.createMediaStreamSource(s);
        const anl = ctx.createAnalyser();
        anl.fftSize = 256;
        src.connect(anl);
        const data = new Uint8Array(anl.frequencyBinCount);
        const bar = document.getElementById(barId);
        
        const upd = () => {
            const m1 = document.getElementById('entry-modal');
            const m2 = document.getElementById('settings-modal');
            if (m1 && m2 && m1.style.display === 'none' && m2.style.display === 'none') {
                s.getTracks().forEach(t => t.stop());
                return;
            }
            anl.getByteFrequencyData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) sum += data[i];
            if (bar) bar.style.width = Math.min(100, (sum / data.length) * 3) + '%';
            requestAnimationFrame(upd);
        };
        upd();
    })
    .catch(e => {});
}

function testSpeaker() {
    const ctx = ensureAudioContext();
    if(ctx) {
        const osc = ctx.createOscillator(); 
        osc.connect(ctx.destination); 
        osc.frequency.value = 523.25; 
        osc.start(); 
        osc.stop(ctx.currentTime + 0.3);
    }
}

function openSettings() { 
    getDevices('micSelectInGame', 'speakerSelectInGame').then(() => {
        if (myStream) {
            const cid = myStream.getAudioTracks()[0].getSettings().deviceId;
            if (cid) document.getElementById('micSelectInGame').value = cid;
        }
        const spk = document.getElementById('speakerSelectInGame');
        if (currentSpeakerId) spk.value = currentSpeakerId;
        const mic = document.getElementById('micSelectInGame');
        mic.onchange = () => startMicTest('micSelectInGame', 'mic-visualizer-bar-game');
        startMicTest('micSelectInGame', 'mic-visualizer-bar-game');
    });
    document.getElementById('settings-modal').style.display = 'flex'; 
}

function closeSettings() { document.getElementById('settings-modal').style.display = 'none'; }

async function applySettings() {
    const micId = document.getElementById('micSelectInGame').value;
    const spkId = document.getElementById('speakerSelectInGame').value;

    if (micId) {
        try {
            const newStream = await navigator.mediaDevices.getUserMedia({
                audio: { deviceId: { exact: micId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            });
            if (myStream) myStream.getTracks().forEach(t => t.stop());
            myStream = newStream;
            setMicState(!isMicMutedByUser); 
            reconnectEveryone();
            alert("設定適用完了");
        } catch (e) { alert("失敗: " + e); }
    }
    
    if (spkId) {
        currentSpeakerId = spkId;
        document.querySelectorAll('audio').forEach(a => {
            if (a.setSinkId) a.setSinkId(spkId).catch(e=>{});
        });
        if (bgmAudio.setSinkId) bgmAudio.setSinkId(spkId).catch(e=>{});
    }
    closeSettings();
}

// ============================
// 9. メイン描画ループ
// ============================
function loop() { draw(); requestAnimationFrame(loop); }

function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0); 
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#2c3e50"; 
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const visibleW = canvas.width / cameraScale;
    const visibleH = canvas.height / cameraScale;
    
    let camX = myX - visibleW / 2;
    let camY = myY - visibleH / 2;
    
    camX = Math.max(0, Math.min(camX, WORLD_W - visibleW));
    camY = Math.max(0, Math.min(camY, WORLD_H - visibleH));

    ctx.save();
    ctx.scale(cameraScale, cameraScale);
    ctx.translate(-camX, -camY);

    if (bgImage.complete) {
        ctx.drawImage(bgImage, 0, 0, WORLD_W, WORLD_H);
    } else {
        ctx.fillStyle = "#eee"; ctx.fillRect(0, 0, WORLD_W, WORLD_H);
    }

    MEETING_ROOMS.forEach(r => {
        ctx.fillStyle = "rgba(41, 128, 185, 0.2)"; 
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.strokeStyle = "rgba(41, 128, 185, 0.9)"; 
        ctx.lineWidth = 4; 
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        ctx.fillStyle = "rgba(0, 0, 0, 0.7)"; 
        ctx.font = "bold 24px sans-serif"; 
        ctx.fillText(r.name, r.x + 30, r.y + 40);
    });

    ctx.fillStyle = "rgba(231, 76, 60, 0.1)"; 
    ctx.fillRect(750, 0, 700, 450); 
    ctx.strokeStyle = "rgba(192, 57, 43, 0.9)"; 
    ctx.lineWidth = 4; 
    ctx.strokeRect(750, 0, 700, 450);
    ctx.fillStyle = "rgba(192, 57, 43, 1)"; 
    ctx.font = "bold 20px sans-serif"; 
    ctx.fillText("🚫 会話禁止 (Focus Zone)", 900, 60);

    if (!myRoomId && getCurrentZone() === ZONES.LIVING) {
        ctx.beginPath();
        ctx.arc(myX, myY, TALK_DISTANCE, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(46, 204, 113, 0.1)"; 
        ctx.fill();
        ctx.strokeStyle = "rgba(46, 204, 113, 0.5)"; 
        ctx.lineWidth = 1; 
        ctx.stroke();
    }

    Object.keys(users).forEach(id => {
        const u = users[id];
        ctx.shadowColor = "rgba(0,0,0,0.3)"; ctx.shadowBlur = 10;
        ctx.fillStyle = (id === myId) ? '#e74c3c' : '#3498db';
        ctx.beginPath(); ctx.arc(u.x, u.y, 20, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = "#fff"; ctx.strokeStyle = "#000"; ctx.lineWidth = 3;
        ctx.font = "bold 14px sans-serif"; ctx.textAlign = "center";
        ctx.strokeText(u.name, u.x, u.y - 30); ctx.fillText(u.name, u.x, u.y - 30);
        if (u.roomId) ctx.fillText("🔒", u.x, u.y - 45);
    });

    ctx.restore();
}

function getWorldPos(cx, cy) {
    const visibleW = canvas.width / cameraScale;
    const visibleH = canvas.height / cameraScale;
    let camX = myX - visibleW / 2;
    let camY = myY - visibleH / 2;
    camX = Math.max(0, Math.min(camX, WORLD_W - visibleW));
    camY = Math.max(0, Math.min(camY, WORLD_H - visibleH));
    return { x: (cx / cameraScale) + camX, y: (cy / cameraScale) + camY };
}