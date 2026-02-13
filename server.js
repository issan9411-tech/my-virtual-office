const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static("public"));
app.use(express.static(__dirname));

let users = {};

// ★部屋ごとのYouTube状態を保存するオブジェクト
// キー: roomId, 値: { videoId, isPlaying, timestamp, isRepeat }
let roomYoutubeStates = {};

io.on("connection", (socket) => {
    // 初期データ
    users[socket.id] = { x: 1400, y: 900, peerId: null, name: "ゲスト", roomId: null };
    
    socket.emit("updateUsers", users);

    socket.on("enterRoom", (data) => {
        if (users[socket.id]) {
            users[socket.id].name = data.name || "名無し";
            users[socket.id].peerId = data.peerId;
            io.emit("updateUsers", users);
        }
    });

    socket.on("move", (data) => {
        if (users[socket.id]) {
            const oldRoom = users[socket.id].roomId;
            const newRoom = data.roomId;
            
            users[socket.id].x = data.x;
            users[socket.id].y = data.y;
            users[socket.id].roomId = newRoom;
            
            io.emit("updateUsers", users);

            // 新しい部屋に入った場合、その部屋のYouTube状態を送る
            if (newRoom && newRoom !== oldRoom) {
                const state = roomYoutubeStates[newRoom] || { videoId: null, isPlaying: false, timestamp: 0, isRepeat: false };
                socket.emit("youtubeSync", state);
            }
        }
    });

    // YouTube制御 (部屋IDを含めて受信)
    socket.on("changeYoutube", (data) => {
        // data = { roomId, videoId, isPlaying, timestamp, isRepeat }
        if (data.roomId) {
            roomYoutubeStates[data.roomId] = data;
            // 全員に送るが、クライアント側で自分の部屋か判定させる
            // (本来はsocket.join/toを使うべきだが、今回は既存ロジックに合わせてブロードキャストし、クライアントでフィルタリング)
            io.emit("youtubeSync", data);
        }
    });

    socket.on("disconnect", () => {
        delete users[socket.id];
        io.emit("updateUsers", users);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});