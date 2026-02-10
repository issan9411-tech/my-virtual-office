// グローバル変数
let socket = null, myPeer = null, myStream = null;
let users = {}, peers = {};
let myId = null, myX = 50, myY = 200;
let currentMicId = 'default';
let isMicMutedByUser = true; // ユーザーが意図的にミュートしているか

// DOM要素
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const statusDiv = document.getElementById('status');
const micBtn = document.getElementById('micBtn');

// エリア定義
const ZONES = {
    WORK: { name: "作業エリア (会話禁止)", x: 0, w: 400, color: "#e0e0e0", allowMic: false },
    LIVING: { name: "リビング (会話OK)", x: 400, w: 400, color: "#b2fab4", allowMic: true },
    MEETING: { name: "会議室 (全員)", x: 800, w: 2000, color: "#b3cde0", allowMic: true }
};

canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

// ----------------------
// 初期化 & デバイス取得
// ----------------------
window.addEventListener('load', async () => {
    const startBtn = document.getElementById('startBtn');
    if (!startBtn) return;

    // デバイス一覧を取得してプルダウンにセット
    await getDevices();

    startBtn.addEventListener('click', () => {
        initGame();
    });
});

async function getDevices() {
    try {
        // 許可を求めるために一度ストリームを取得（すぐ止める）
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());

        const devices = await navigator.mediaDevices.enumerateDevices();
        const micSelect = document.getElementById('micSelect');
        const spkSelect = document.getElementById('speakerSelect');

        micSelect.innerHTML = '';
        spkSelect.innerHTML = '';

        devices.forEach(d => {
            const option = document.createElement('option');
            option.value = d.deviceId;
            option.text = d.label || `${d.kind} - ${d.deviceId.substr(0,5)}`;
            
            if (d.kind === 'audioinput') micSelect.appendChild(option);
            if (d.kind === 'audiooutput') spkSelect.appendChild(option);
        });

    } catch (e) {
        console.error("デバイス取得エラー", e);
    }
}

// ----------------------
// ゲーム開始
// ----------------------
function initGame() {
    const startBtn = document.getElementById('startBtn');
    startBtn.innerText = "接続中...";
    startBtn.disabled = true;

    // 選択されたマイクを取得
    const micId = document.getElementById('micSelect').value;
    currentMicId = micId;

    const constraints = {
        audio: { deviceId: micId ? { exact: micId } : undefined }
    };

    navigator.mediaDevices.getUserMedia(constraints)
        .then(stream => {
            myStream = stream;
            // 初期状態はミュート
            setMicState(false);
            startConnection();
        })
        .catch(err => {
            alert("マイクが取得できませんでした: " + err);
            startBtn.disabled = false;
        });
}

function startConnection() {
    socket = io();
    socket.on('connect', () => {
        myId = socket.id;
        document.getElementById('overlay').style.display = 'none';
        statusDiv.innerText = "接続完了";
    });

    socket.on('updateUsers', (data) => {
        users = data;
        draw();
        connectToUsers();
    });

    myPeer = new Peer();
    myPeer.on('open', id => socket.emit('joinVoice', id));
    
    myPeer.on('call', call => {
        call.answer(myStream);
        handleStream(call);
    });

    // 初期描画
    checkZone();
    draw();
}

// ----------------------
// マイク & エリア制御
// ----------------------

// エリア判定とボタン制御
function checkZone() {
    const zone = getZone(myX);
    
    // エリアが変わったときのボタン制御
    if (!zone.allowMic) {
        // 強制オフエリア
        micBtn.disabled = true;
        micBtn.innerText = "🚫 会話禁止エリア";
        micBtn.style.background = "#555";
        setMicState(false); // 強制ミュート
    } else {
        // 会話可能エリア
        micBtn.disabled = false;
        // ユーザーが意図的にONにしていればON、そうでなければOFF
        updateMicBtnDesign();
        setMicState(!isMicMutedByUser);
    }

    statusDiv.innerText = `現在地: ${zone.name}`;
}

// マイクの物理的なON/OFF
function setMicState(isOn) {
    if (!myStream) return;
    const track = myStream.getAudioTracks()[0];
    if(track) track.enabled = isOn;
}

// ユーザーがボタンを押したとき
function toggleMic() {
    isMicMutedByUser = !isMicMutedByUser; // フラグを反転
    updateMicBtnDesign();
    
    // 現在のエリア設定に合わせて反映
    const zone = getZone(myX);
    if (zone.allowMic) {
        setMicState(!isMicMutedByUser);
    }
}

// ボタンのデザイン更新
function updateMicBtnDesign() {
    if (isMicMutedByUser) {
        micBtn.innerText = "マイクOFF";
        micBtn.style.background = "#e74c3c"; // 赤
    } else {
        micBtn.innerText = "マイクON 🎙️";
        micBtn.style.background = "#4CAF50"; // 緑
    }
}

function getZone(x) {
    if (x < ZONES.WORK.x + ZONES.WORK.w) return ZONES.WORK;
    if (x < ZONES.LIVING.x + ZONES.LIVING.w) return ZONES.LIVING;
    return ZONES.MEETING;
}

// ----------------------
// 設定 & スピーカー
// ----------------------
function openSettings() {
    document.getElementById('settings-modal').style.display = 'block';
}

function closeSettings() {
    document.getElementById('settings-modal').style.display = 'none';
    
    // スピーカー変更の適用 (Chrome/Edgeのみ対応)
    const speakerId = document.getElementById('speakerSelect').value;
    if (speakerId) {
        document.querySelectorAll('audio').forEach(audio => {
            if (audio.setSinkId) {
                audio.setSinkId(speakerId).catch(e => console.warn("スピーカー変更不可", e));
            }
        });
    }

    // ※マイクの変更はリロードが必要なため、今回はスピーカーのみ即時反映としています
}


// ----------------------
// 音声接続 & 描画（前回とほぼ同じ）
// ----------------------
function handleStream(call) {
    call.on('stream', userAudio => {
        if (document.getElementById(call.peer)) return;
        const audio = document.createElement('audio');
        audio.id = call.peer;
        audio.srcObject = userAudio;
        
        // スピーカー設定の適用
        const speakerId = document.getElementById('speakerSelect').value;
        if (speakerId && audio.setSinkId) {
            audio.setSinkId(speakerId);
        }

        audio.play().catch(e => console.log(e));
        document.body.appendChild(audio);
    });
    call.on('close', () => {
        const el = document.getElementById(call.peer);
        if(el) el.remove();
    });
}

function connectToUsers() {
    if (!myPeer || !myStream) return;
    const myZone = getZone(myX);
    
    // 自分が会話禁止エリアなら接続処理もしない
    if (!myZone.allowMic) return; 

    Object.keys(users).forEach(id => {
        if (id === myId) return;
        const u = users[id];
        const userZone = getZone(u.x);
        
        if (u.peerId && userZone.allowMic && !peers[id]) {
            const call = myPeer.call(u.peerId, myStream);
            peers[id] = call;
            handleStream(call);
        }
    });
}

document.addEventListener('keydown', e => {
    if (!socket) return;
    const step = 15;
    if (e.key === 'ArrowUp') myY -= step;
    if (e.key === 'ArrowDown') myY += step;
    if (e.key === 'ArrowLeft') myX -= step;
    if (e.key === 'ArrowRight') myX += step;
    socket.emit('move', { x: myX, y: myY });
    
    checkZone();
    draw();
});

function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    [ZONES.WORK, ZONES.LIVING, ZONES.MEETING].forEach(z => {
        ctx.fillStyle = z.color;
        ctx.fillRect(z.x, 0, z.w, canvas.height);
        ctx.fillStyle = "#555";
        ctx.font = "bold 20px sans-serif";
        ctx.fillText(z.name, z.x + 20, 50);
    });
    Object.keys(users).forEach(id => {
        const u = users[id];
        ctx.fillStyle = (id === myId) ? '#e74c3c' : '#3498db';
        ctx.beginPath();
        ctx.arc(u.x, u.y, 20, 0, Math.PI * 2);
        ctx.fill();
    });
}