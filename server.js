const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static("public"));
app.use(express.static(__dirname));

let users = {};
let roomYoutubeStates = {}; // 部屋ごとのYouTube状態
let roomScreenShares = {};  // 部屋ごとの画面共有者ID

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

            // 部屋移動時の同期処理
            if (newRoom && newRoom !== oldRoom) {
                // YouTube同期
                const ytState = roomYoutubeStates[newRoom] || { videoId: null, isPlaying: false, timestamp: 0, isRepeat: false };
                socket.emit("youtubeSync", ytState);

                // 画面共有同期 (誰が共有しているか)
                const sharerId = roomScreenShares[newRoom] || null;
                socket.emit("screenShareSync", { roomId: newRoom, sharerId: sharerId });
            }

            // 前の部屋で共有していたら停止
            if (oldRoom && roomScreenShares[oldRoom] === socket.id) {
                delete roomScreenShares[oldRoom];
                io.emit("screenShareSync", { roomId: oldRoom, sharerId: null });
            }
        }
    });

    // YouTube制御
    socket.on("changeYoutube", (data) => {
        if (data.roomId) {
            roomYoutubeStates[data.roomId] = data;
            io.emit("youtubeSync", data);
        }
    });

    // 画面共有状態の更新
    socket.on("updateScreenShare", (data) => {
        // data = { roomId, isSharing }
        if (data.roomId) {
            if (data.isSharing) {
                roomScreenShares[data.roomId] = socket.id;
            } else {
                if (roomScreenShares[data.roomId] === socket.id) {
                    delete roomScreenShares[data.roomId];
                }
            }
            io.emit("screenShareSync", { 
                roomId: data.roomId, 
                sharerId: data.isSharing ? socket.id : null 
            });
        }
    });

    socket.on("disconnect", () => {
        const userRoom = users[socket.id]?.roomId;
        // 切断時に共有停止
        if (userRoom && roomScreenShares[userRoom] === socket.id) {
            delete roomScreenShares[userRoom];
            io.emit("screenShareSync", { roomId: userRoom, sharerId: null });
        }
        delete users[socket.id];
        io.emit("updateUsers", users);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});