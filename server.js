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

// ★画面共有の状態管理
// key: roomId, value: socketId (共有している人のID)
let roomScreenShares = {};

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

            // 部屋移動時の処理
            if (newRoom && newRoom !== oldRoom) {
                // YouTube状態同期
                const ytState = roomYoutubeStates[newRoom] || { videoId: null, isPlaying: false, timestamp: 0, isRepeat: false };
                socket.emit("youtubeSync", ytState);

                // 画面共有状態同期
                if (roomScreenShares[newRoom]) {
                    // 誰かが共有中なら通知
                    socket.emit("screenShareSync", { sharerId: roomScreenShares[newRoom] });
                } else {
                    socket.emit("screenShareSync", { sharerId: null });
                }
            }

            // 前の部屋で共有していたら停止させる
            if (oldRoom && roomScreenShares[oldRoom] === socket.id) {
                delete roomScreenShares[oldRoom];
                io.emit("screenShareSync", { sharerId: null, roomId: oldRoom });
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

    // ★画面共有の状態変更通知
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
            // 全員に「この部屋で誰が共有しているか（または誰もしていないか）」を通知
            io.emit("screenShareSync", { 
                roomId: data.roomId, 
                sharerId: data.isSharing ? socket.id : null 
            });
        }
    });

    socket.on("disconnect", () => {
        // 切断時に画面共有情報をクリア
        const userRoom = users[socket.id]?.roomId;
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