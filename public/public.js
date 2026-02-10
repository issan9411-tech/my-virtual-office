const socket = io();
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const statusDiv = document.getElementById('status');

canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

let myId = null;
let myX = 50;
let myY = 200;
let users = {};
let myStream = null;
let myPeer = null;
let peers = {}; 

// エリア定義
const ZONES = {
  WORK: { name: "作業エリア (静寂)", x: 0, w: 400, color: "#e0e0e0", mic: false },
  LIVING: { name: "リビング (会話)", x: 400, w: 400, color: "#b2fab4", mic: true },
  MEETING: { name: "会議室 (全員)", x: 800, w: 1200, color: "#b3cde0", mic: true }
};

function initGame() {
    document.getElementById('overlay').style.display = 'none';
    
    // マイク取得
    navigator.mediaDevices.getUserMedia({ video: false, audio: true }).then(stream => {
        myStream = stream;
        
        // PeerJSサーバーは公式の無料クラウドを利用 (設定不要)
        myPeer = new Peer();

        myPeer.on('open', id => {
            socket.emit('joinVoice', id);
        });

        myPeer.on('call', call => {
            call.answer(myStream);
            handleStream(call);
        });

        checkZone(); 
    }).catch(e => {
        alert("マイクエラー: " + e);
    });
}

function handleStream(call) {
    call.on('stream', userAudio => {
        // すでに音声タグがあれば作らない
        if(document.getElementById(call.peer)) return;
        
        const audio = document.createElement('audio');
        audio.id = call.peer; // ID管理
        audio.srcObject = userAudio;
        audio.play();
    });
}

socket.on('connect', () => {
    myId = socket.id;
});

socket.on('updateUsers', (data) => {
    users = data;
    draw();
    connectToUsers();
});

function connectToUsers() {
    if (!myPeer || !myStream) return;
    
    // 自分が会話可能エリアにいるか？
    const myZone = getZone(myX);
    if (!myZone.mic) return; // 自分は黙る

    Object.keys(users).forEach(id => {
        if (id === myId) return;
        const u = users[id];
        
        // 相手も会話可能エリアにいるなら接続
        const userZone = getZone(u.x);
        
        if (u.peerId && userZone.mic && !peers[id]) {
            const call = myPeer.call(u.peerId, myStream);
            peers[id] = call;
            handleStream(call);
        }
    });
}

function getZone(x) {
    if (x < ZONES.WORK.x + ZONES.WORK.w) return ZONES.WORK;
    if (x < ZONES.LIVING.x + ZONES.LIVING.w) return ZONES.LIVING;
    return ZONES.MEETING;
}

// 移動操作
document.addEventListener('keydown', e => {
    const step = 15;
    if (e.key === 'ArrowUp') myY -= step;
    if (e.key === 'ArrowDown') myY += step;
    if (e.key === 'ArrowLeft') myX -= step;
    if (e.key === 'ArrowRight') myX += step;
    socket.emit('move', { x: myX, y: myY });
    checkZone();
});

function checkZone() {
    if (!myStream) return;
    const zone = getZone(myX);
    
    // マイクのON/OFF切り替え
    myStream.getAudioTracks()[0].enabled = zone.mic;
    statusDiv.innerText = `エリア: ${zone.name} | マイク: ${zone.mic ? 'ON' : 'OFF'}`;
}

function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // 背景
    [ZONES.WORK, ZONES.LIVING, ZONES.MEETING].forEach(z => {
        ctx.fillStyle = z.color;
        ctx.fillRect(z.x, 0, z.w, canvas.height);
        ctx.fillStyle = "#555";
        ctx.font = "20px Arial";
        ctx.fillText(z.name, z.x + 20, 50);
    });

    // ユーザー
    Object.keys(users).forEach(id => {
        const u = users[id];
        ctx.fillStyle = (id === myId) ? '#e74c3c' : '#3498db';
        ctx.beginPath();
        ctx.arc(u.x, u.y, 20, 0, Math.PI * 2);
        ctx.fill();
    });
}