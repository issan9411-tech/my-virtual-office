const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static("public"));
app.use(express.static(__dirname));

let users = {};
// YouTubeの現在の状態を保存する変数
let currentYoutube = {
    videoId: null,
    isPlaying: false,
    mode: 'video', // 'video' or 'audio'
    timestamp: 0
};

io.on("connection", (socket) => {
    // 初期データ
    users[socket.id] = { x: 1400, y: 900, peerId: null, name: "ゲスト", roomId: null };
    
    // 接続時に現在のYouTube状態を送る
    socket.emit("youtubeSync", currentYoutube);

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
            users[socket.id].x = data.x;
            users[socket.id].y = data.y;
            users[socket.id].roomId = data.roomId;
            io.emit("updateUsers", users);
        }
    });

    // YouTube制御
    socket.on("changeYoutube", (data) => {
        currentYoutube = data;
        // 全員に同期信号を送る
        io.emit("youtubeSync", currentYoutube);
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