const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static("public"));
app.use(express.static(__dirname));

let users = {};
let roomYoutubeStates = {}; 
let roomScreenShares = {}; // key: roomId, value: socketId

io.on("connection", (socket) => {
    // 初期化
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

            // 部屋移動時の同期
            if (newRoom && newRoom !== oldRoom) {
                // YouTube同期
                const ytState = roomYoutubeStates[newRoom] || { videoId: null, isPlaying: false, timestamp: 0, isRepeat: false };
                socket.emit("youtubeSync", ytState);

                // 画面共有同期
                const sharerId = roomScreenShares[newRoom] || null;
                socket.emit("screenShareSync", { roomId: newRoom, sharerId: sharerId });
            }

            // 前の部屋で共有していたら強制解除
            if (oldRoom && roomScreenShares[oldRoom] === socket.id) {
                delete roomScreenShares[oldRoom];
                io.emit("screenShareSync", { roomId: oldRoom, sharerId: null });
            }
        }
    });

    socket.on("changeYoutube", (data) => {
        if (data.roomId) {
            roomYoutubeStates[data.roomId] = data;
            io.emit("youtubeSync", data);
        }
    });

    // ★画面共有の状態更新 (確実にリセットする)
    socket.on("updateScreenShare", (data) => {
        if (data.roomId) {
            if (data.isSharing) {
                // 開始: IDを登録
                roomScreenShares[data.roomId] = socket.id;
            } else {
                // 停止: 該当IDがあれば確実に削除
                if (roomScreenShares[data.roomId]) {
                    delete roomScreenShares[data.roomId];
                }
            }
            // 全員に「現在の共有者ID（いない場合はnull）」を送信
            io.emit("screenShareSync", { 
                roomId: data.roomId, 
                sharerId: roomScreenShares[data.roomId] || null 
            });
        }
    });

    socket.on("disconnect", () => {
        const userRoom = users[socket.id]?.roomId;
        // 切断時に共有情報も削除
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