const { WebSocketServer } = require("ws");

const WS_PORT = 8765;
const clients = new Set();

const wss = new WebSocketServer({ port: WS_PORT, perMessageDeflate: false });

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  const isSource = req.headers['origin']?.includes('rapidlaunch') || req.url === '/source';
  ws.role = isSource ? 'source' : 'viewer';

  clients.add(ws);
  console.log(`[WS] ${ws.role} connecté (${clients.size} total)`);

  ws.on("message", (raw) => {
    let tweet;
    try { tweet = JSON.parse(raw); } catch { return; }
    if (!tweet?.author) return; // text peut être vide pour les retweets

    console.log(`[TW] ${tweet.author} (${tweet.at})`);

    const msg = JSON.stringify(tweet);
    for (const c of clients) {
      if (c !== ws && c.readyState === 1) {
        c.send(msg);
      }
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log(`[WS] Déconnecté (${clients.size} restant)`);
  });
});

console.log(`[SERVEUR] Écoute sur le port ${WS_PORT}`);