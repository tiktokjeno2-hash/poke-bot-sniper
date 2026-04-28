const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

// ==========================================
// 🎯 ลิงก์ API ฉบับสมบูรณ์
// ==========================================
const URL_RECENT_PULLS = "https://shiny.com/api/pack/3/recent-pulls"; 
const URL_PACK_STATUS = "https://shiny.com/api/jackpot/state?tier=2500&tcgType=Pokemon"; 
const BASE_URL = "https://shiny.com"; 
// ==========================================

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const HISTORY_FILE = 'history.json';
const MAX_MEMORY = 500; // จำประวัติ 500 ใบ เพื่อให้นับสถิติได้ลึกขึ้น

const tierMap = { 
    'S': 'Shiny', 'A': 'Platinum', 'B': 'Gold', 'C': 'Silver', 'D': 'Bronze',
    'Shiny': 'Shiny', 'Platinum': 'Platinum', 'Gold': 'Gold', 'Silver': 'Silver', 'Bronze': 'Bronze' 
};

let standardOdds = { 'Shiny': 0.005, 'Platinum': 0.062, 'Gold': 0.433, 'Silver': 0.075, 'Bronze': 0.425 };

let state = {
    lastPullId: 0,
    apiStatus: { since: 0, target: 200, stage: 0, prizeName: "", prizeImg: "" },
    globalData: { recentCards: [] }
};

if (fs.existsSync(HISTORY_FILE)) {
    try { state.globalData = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (e) {}
}

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });
io.on('connection', (socket) => { sendUpdate(); });

// 🧠 1. ระบบวิเคราะห์เทรนด์ % จาก 16 ใบหลังสุด
function calculateProbs() {
    const history = state.globalData.recentCards;
    const recent16 = history.slice(0, 16);

    if (recent16.length === 0) {
        let defaultProbs = {};
        for (let t in standardOdds) { defaultProbs[t] = (standardOdds[t] * 100).toFixed(1); }
        return defaultProbs;
    }

    const counts = recent16.reduce((acc, c) => { acc[c.tier] = (acc[c.tier] || 0) + 1; return acc; }, {});
    let probs = {}; let totalW = 0;
    
    for (let t in standardOdds) {
        let currentFreq = (counts[t] || 0) / recent16.length;
        let weight = standardOdds[t] + ((standardOdds[t] - currentFreq) * 2.5); 
        probs[t] = Math.max(weight, 0.0001); 
        totalW += probs[t];
    }
    for (let t in probs) { probs[t] = ((probs[t] / totalW) * 100).toFixed(1); }
    return probs;
}

// 📊 2. ระบบนับจำนวนใบที่ขาดหาย (แจ้งเตือน 4 ระดับแบบหน้าเว็บ)
function calculateStats() {
    const history = state.globalData.recentCards;
    let stats = {};

    for (let t in standardOdds) {
        let prob = standardOdds[t];
        let average = Math.round(1 / prob); 

        let passed = 0;
        for (let i = 0; i < history.length; i++) {
            if (history[i].tier === t) break;
            passed++;
        }

        let remaining = average - passed;
        let status = "ลุ้นได้เลย";
        let colorCode = "normal";
        
        // เงื่อนไขแจ้งเตือนระดับความตึง
        if (passed >= average * 1.5) {
            status = "เลยกำหนดนานแล้ว";
            colorCode = "danger"; 
            remaining = 0;
        } else if (passed >= average) {
            status = "จะมาเร็วๆ นี้";
            colorCode = "warning"; 
            remaining = 0;
        } else if (passed < average * 0.4) {
            status = "ยังเร็วเกินไป";
            colorCode = "early"; 
        }

        stats[t] = {
            average: average,
            passed: passed,
            remaining: remaining > 0 ? remaining : 0,
            status: status,
            colorCode: colorCode
        };
    }
    return stats;
}

function processItem(item) {
    const rawTier = item.tier || item.cardTier || item.rarity || 'D';
    const tierName = tierMap[rawTier] || 'Bronze'; 
    let imgUrl = item.thumbnailUrl || item.image || "https://via.placeholder.com/100x140?text=No+Img";
    if (!imgUrl.startsWith('http')) imgUrl = BASE_URL + imgUrl;

    state.globalData.recentCards.unshift({
        tier: tierName, img: imgUrl, price: item.worth || item.value || item.price || 0, name: item.cardName || item.name || "Unknown Card"
    });
    if (state.globalData.recentCards.length > MAX_MEMORY) state.globalData.recentCards.pop();
}

async function fetchData() {
    try {
        const [resStatus, resPulls] = await Promise.all([
            fetch(URL_PACK_STATUS, { signal: AbortSignal.timeout(5000) }).catch(() => null),
            fetch(URL_RECENT_PULLS, { signal: AbortSignal.timeout(5000) }).catch(() => null)
        ]);

        if (resStatus && resStatus.ok) {
            const s = await resStatus.json();
            let bonusImg = "";
            if (s.prizeCard && s.prizeCard.thumbnailUrl) {
                bonusImg = s.prizeCard.thumbnailUrl.startsWith('http') ? s.prizeCard.thumbnailUrl : BASE_URL + s.prizeCard.thumbnailUrl;
            }

            if (s.odds) {
                standardOdds = {
                    'Shiny': s.odds.S || standardOdds.Shiny,
                    'Platinum': s.odds.A || standardOdds.Platinum,
                    'Gold': s.odds.B || standardOdds.Gold,
                    'Silver': s.odds.C || standardOdds.Silver,
                    'Bronze': s.odds.D || standardOdds.Bronze
                };
            }

            state.apiStatus = {
                since: s.opensWithoutWin !== undefined ? s.opensWithoutWin : state.apiStatus.since,
                target: s.nextStageAt || state.apiStatus.target,
                stage: s.stage !== undefined ? s.stage : state.apiStatus.stage,
                prizeName: (s.prizeCard && s.prizeCard.name) ? s.prizeCard.name : state.apiStatus.prizeName || "Target Bonus",
                prizeImg: bonusImg || state.apiStatus.prizeImg
            };
        }

        if (resPulls && resPulls.ok) {
            const pData = await resPulls.json();
            const pulls = Array.isArray(pData) ? pData : (pData.data || []);
            if (pulls.length > 0) {
                if (state.lastPullId === 0) {
                    state.lastPullId = pulls[0].id;
                    pulls.slice(0, 30).reverse().forEach(i => processItem(i));
                } else {
                    let news = pulls.filter(i => i.id > state.lastPullId).reverse();
                    if (news.length > 0) {
                        news.forEach(i => processItem(i));
                        state.lastPullId = pulls[0].id;
                    }
                }
            }
        }
        
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(state.globalData));
        sendUpdate();

    } catch (e) {
        console.log("⚡ API ดีเลย์...");
    }
}

function sendUpdate() {
    const probs = calculateProbs(); 
    const stats = calculateStats(); 
    let top = "---"; let max = 0;
    
    if (probs) {
        for (let t in probs) { if (parseFloat(probs[t]) > max) { max = parseFloat(probs[t]); top = t; } }
    }
    
    io.emit('update_data', { 
        status: state.apiStatus, 
        cards: state.globalData.recentCards.slice(0, 30), 
        probs: probs, 
        stats: stats, 
        top: top 
    });
}

setInterval(fetchData, 3000);
fetchData();
// 🟢 ให้ระบบคลาวด์เลือก Port ให้อัตโนมัติ
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 PokéTracker Sniper Ultimate Live on port ${PORT}!`));