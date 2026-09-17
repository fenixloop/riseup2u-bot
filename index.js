/**
 * RiseUp2u.com - 24/7 On-Chain Telegram Event Listener & Personal Alerts Bot
 * ----------------------------------------------------------------------------
 * 1. Broadcasts all on-chain protocol events to community channel (@RiseUp2u).
 * 2. Provides PERSONAL direct alerts to individual members when their specific
 *    wallet receives commissions, sponsor bonuses, or completes matrix cycles.
 *
 * Activation for members:
 *   Open t.me/RiseUp2uBot?start=0xUserWalletAddress
 *   Or click "Connect Telegram Bot" in RiseUp2u Dashboard.
 *
 * Usage:
 *   node scripts/telegram-listener.js             (Run listener & bot)
 *   node scripts/telegram-listener.js --test      (Send test message to channel)
 *   node scripts/telegram-listener.js --testnet   (Monitor BSC Testnet)
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { ethers } = require('ethers');

// --- 0. LIGHTWEIGHT HEALTH CHECK SERVER (FOR RENDER FREE WEB SERVICE) ---
const PORT = process.env.PORT || 3000;
const healthServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        status: 'online',
        service: 'RiseUp2u Telegram Listener & Alerts Bot',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    }));
});
healthServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[Health Server] Listening on 0.0.0.0:${PORT} (Render Free Tier Ready)`);
});

// --- 1. CONFIGURATION & ENVIRONMENT LOADER ---
function loadEnv() {
    const candidatePaths = [
        path.resolve(__dirname, '.env'),
        path.resolve(__dirname, '../.env')
    ];
    for (const envPath of candidatePaths) {
        if (fs.existsSync(envPath)) {
            const content = fs.readFileSync(envPath, 'utf8');
            content.split('\n').forEach(line => {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#')) {
                    const eqIndex = trimmed.indexOf('=');
                    if (eqIndex > 0) {
                        const key = trimmed.slice(0, eqIndex).trim();
                        const val = trimmed.slice(eqIndex + 1).trim().replace(/^['"]|['"]$/g, '');
                        if (!process.env[key]) {
                            process.env[key] = val;
                        }
                    }
                }
            });
            break;
        }
    }
}
loadEnv();

const args = process.argv.slice(2);
const IS_TEST_MODE = args.includes('--test');
const IS_TESTNET = args.includes('--testnet') || process.env.NETWORK === 'bscTestnet';

/// Clean & sanitize Ethereum address format (prevents ENS lookup crashes on BSC)
function cleanAddress(addr) {
    if (!addr) return '0xFDF5B6986ee0AF2Ab5941C581F9eB641B52A9ED0';
    const trimmed = String(addr).trim().replace(/^['"]|['"]$/g, '').trim();
    try {
        return ethers.getAddress(trimmed);
    } catch {
        return '0xFDF5B6986ee0AF2Ab5941C581F9eB641B52A9ED0';
    }
}

// Telegram Settings
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '@RiseUp2u';

// BSC Network Details
const NETWORKS = {
    bscMainnet: {
        chainId: 56,
        name: 'BNB Smart Chain (Mainnet)',
        explorerUrl: 'https://bscscan.com',
        contractAddress: cleanAddress(process.env.CONTRACT_ADDRESS || '0xFDF5B6986ee0AF2Ab5941C581F9eB641B52A9ED0'),
        rpcUrls: [
            process.env.BSC_RPC_URL,
            'https://binance.llamarpc.com',
            'https://bsc-dataseed.binance.org/',
            'https://bsc-dataseed1.defibit.io/',
            'https://bsc-dataseed1.ninicoin.io/',
            'https://bsc.meowrpc.com',
            'https://1rpc.io/bnb',
            'https://bsc-rpc.publicnode.com'
        ].filter(Boolean)
    },
    bscTestnet: {
        chainId: 97,
        name: 'BNB Smart Chain (Testnet)',
        explorerUrl: 'https://testnet.bscscan.com',
        contractAddress: cleanAddress(process.env.CONTRACT_ADDRESS || '0x55DDcf9A34104046D9ebd97feD15a3407dbe0109'),
        rpcUrls: [
            process.env.BSC_TESTNET_RPC_URL,
            'https://bsc-testnet-rpc.publicnode.com',
            'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
            'https://bsc-testnet.publicnode.com'
        ].filter(Boolean)
    }
};

const ACTIVE_NET = IS_TESTNET ? NETWORKS.bscTestnet : NETWORKS.bscMainnet;

// RiseUp2u Protocol — 7 Package Tiers (T0–T6)
const PACKAGES = {
    0: { tag: 'Starter', size: 10, minTvl: 0 },
    1: { tag: 'Basic', size: 25, minTvl: 0 },
    2: { tag: 'Standard', size: 50, minTvl: 5000 },
    3: { tag: 'Advanced', size: 100, minTvl: 15000 },
    4: { tag: 'Pro', size: 250, minTvl: 50000 },
    5: { tag: 'Elite', size: 500, minTvl: 250000 },
    6: { tag: 'Whale', size: 1000, minTvl: 500000 }
};

// Contract Events ABI — RiseUp2u CommunitySolidarity & Backward Compatible
const EVENT_ABI = [
    // Support & Rise Native Events (CommunitySolidarity.sol)
    "event Supported(address indexed user, uint256 indexed unitId, uint256 indexed tierId, uint256 amount, uint256 unlockTime)",
    "event Risen(address indexed user, uint256 indexed unitId, uint256 principal, uint256 benefit, uint256 totalPayout)",
    "event ReSupported(address indexed user, uint256 indexed oldUnitId, uint256 indexed newUnitId, uint256 amount)",
    "event HostRegistered(address indexed user, address indexed host)",
    "event CommunityShareCredited(address indexed upline, address indexed fromUser, uint256 tier, uint256 amount)",
    "event CommunityShareBreakageRetained(address indexed fromUser, uint256 tier, uint256 amount)",
    "event CommunityShareRisen(address indexed user, uint256 amount)",
    "event SolidarityRisen(address indexed user, uint256 amount)",
    "event CommunityReservePaid(address indexed treasury, uint256 amount)",
    "event LiquidityInjected(address indexed provider, uint256 amount)",

    // Legacy Fallback Events
    "event Committed(address indexed user, uint256 indexed orderId, uint256 indexed packageId, uint256 amount, uint256 unlockTime)",
    "event Claimed(address indexed user, uint256 indexed orderId, uint256 principal, uint256 reward, uint256 totalPayout)",
    "event Recommitted(address indexed user, uint256 indexed oldOrderId, uint256 indexed newOrderId, uint256 amount)",
    "event SponsorRegistered(address indexed user, address indexed sponsor)",
    "event UnilevelCredited(address indexed upline, address indexed fromUser, uint256 level, uint256 amount)",
    "event UnilevelBreakageRetained(address indexed fromUser, uint256 level, uint256 amount)",
    "event UnilevelClaimed(address indexed user, uint256 amount)",
    "event ProtocolReservePaid(address indexed treasury, uint256 amount)"
];

// --- 2. SUBSCRIBER DATABASE & NETWORK TREE (WALLET <-> TELEGRAM & HIERARCHY) ---
const CACHE_DIR = path.resolve(__dirname, 'cache');
const SUBSCRIBERS_FILE = path.join(CACHE_DIR, 'subscribers.json');
const NETWORK_TREE_FILE = path.join(CACHE_DIR, 'network_tree.json');

function getNetworkTree() {
    try {
        if (fs.existsSync(NETWORK_TREE_FILE)) {
            const raw = fs.readFileSync(NETWORK_TREE_FILE, 'utf8');
            return JSON.parse(raw);
        }
    } catch (e) {
        console.warn('Error reading network tree file:', e.message);
    }
    return {
        members: {},
        sponsors: {}
    };
}

function saveNetworkRegistration(user, sponsor, txHash, blockNumber) {
    try {
        if (!fs.existsSync(CACHE_DIR)) {
            fs.mkdirSync(CACHE_DIR, { recursive: true });
        }
        const tree = getNetworkTree();
        if (!tree.members) tree.members = {};
        if (!tree.sponsors) tree.sponsors = {};

        const userLower = user.toLowerCase();
        const sponsorLower = sponsor.toLowerCase();

        if (!tree.members[userLower]) {
            tree.members[userLower] = {
                wallet: user,
                sponsor: sponsor,
                joinedAt: new Date().toISOString(),
                blockNumber: blockNumber || null,
                txHash: txHash || null,
                directs: []
            };
        }

        if (!tree.sponsors[sponsorLower]) {
            tree.sponsors[sponsorLower] = [];
        }
        if (!tree.sponsors[sponsorLower].includes(userLower)) {
            tree.sponsors[sponsorLower].push(userLower);
        }

        if (tree.members[sponsorLower]) {
            if (!tree.members[sponsorLower].directs) tree.members[sponsorLower].directs = [];
            if (!tree.members[sponsorLower].directs.includes(userLower)) {
                tree.members[sponsorLower].directs.push(userLower);
            }
        }

        fs.writeFileSync(NETWORK_TREE_FILE, JSON.stringify(tree, null, 2));
        console.log(`[Network Tree] Indexed member ${user} under sponsor ${sponsor}`);
    } catch (e) {
        console.error('Error saving network registration:', e.message);
    }
}

function getSubscribers() {
    try {
        if (fs.existsSync(SUBSCRIBERS_FILE)) {
            return JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE, 'utf8'));
        }
    } catch (e) {
        console.warn('Error reading subscribers file:', e.message);
    }
    return {};
}

function saveSubscriber(wallet, info) {
    try {
        if (!fs.existsSync(CACHE_DIR)) {
            fs.mkdirSync(CACHE_DIR, { recursive: true });
        }
        const subs = getSubscribers();
        subs[wallet.toLowerCase()] = {
            ...info,
            updatedAt: new Date().toISOString()
        };
        fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify(subs, null, 2));
        console.log(`[Subscribers] Saved wallet: ${wallet} for Telegram Chat ID: ${info.chatId}`);
    } catch (e) {
        console.error('Error saving subscriber:', e.message);
    }
}

function removeSubscriber(chatId) {
    try {
        const subs = getSubscribers();
        let removedWallet = null;
        for (const [w, info] of Object.entries(subs)) {
            if (String(info.chatId) === String(chatId)) {
                delete subs[w];
                removedWallet = w;
            }
        }
        if (removedWallet) {
            fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify(subs, null, 2));
            console.log(`[Subscribers] Removed subscription for Chat ID: ${chatId} (Wallet: ${removedWallet})`);
        }
        return removedWallet;
    } catch (e) {
        console.error('Error removing subscriber:', e.message);
        return null;
    }
}

// --- 3. TELEGRAM MESSAGING SERVICE (CHANNEL & DIRECT DM) ---
const messageQueue = [];
let isProcessingQueue = false;

async function sendTelegramRaw(htmlMessage, targetChatId = CHANNEL_CHAT_ID) {
    if (!BOT_TOKEN) {
        console.warn('[Telegram] Warning: TELEGRAM_BOT_TOKEN not set. Message output below:\n', htmlMessage);
        return;
    }

    const endpoint = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: targetChatId,
                text: htmlMessage,
                parse_mode: 'HTML',
                disable_web_page_preview: true
            })
        });

        const data = await res.json();
        if (!data.ok) {
            console.error(`[Telegram API Error for ${targetChatId}]:`, data.description);
            if (data.error_code === 429) {
                const retryAfter = (data.parameters?.retry_after || 5) * 1000;
                await new Promise(r => setTimeout(r, retryAfter));
            }
        }
    } catch (err) {
        console.error('[Telegram Network Error]:', err.message);
    }
}

function queueTelegramMessage(htmlMessage, targetChatId = CHANNEL_CHAT_ID) {
    messageQueue.push({ msg: htmlMessage, chatId: targetChatId });
    processMessageQueue();
}

async function processMessageQueue() {
    if (isProcessingQueue || messageQueue.length === 0) return;
    isProcessingQueue = true;

    while (messageQueue.length > 0) {
        const item = messageQueue.shift();
        await sendTelegramRaw(item.msg, item.chatId);
        // Stagger messages by 600ms to stay within Telegram flood control limits
        await new Promise(r => setTimeout(r, 600));
    }

    isProcessingQueue = false;
}

// Helpers
function shorten(addr) {
    if (!addr) return '0x0000...0000';
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function linkAddr(addr) {
    return `<a href="${ACTIVE_NET.explorerUrl}/address/${addr}"><b>${shorten(addr)}</b></a>`;
}

function linkTx(hash) {
    return `<a href="${ACTIVE_NET.explorerUrl}/tx/${hash}">View on BscScan ↗</a>`;
}

function formatUsdt(weiVal) {
    return parseFloat(ethers.formatUnits(weiVal, 18)).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

// --- 4. EVENT FORMATTERS & PERSONAL ALERTS DISPATCHER (RiseUp2u Protocol) ---

// Helper: resolve package tag from id
function pkgLabel(tierId) {
    const pkg = PACKAGES[Number(tierId)];
    return pkg ? `Tier ${tierId} (${pkg.tag} - $${pkg.size} USDT)` : `Tier ${tierId}`;
}

// ── EVENT: Supported (Mutual Support Extended) ───────────────────
function handleSupported(event, txHash) {
    const args = event.args;
    const user = args.user;
    const unitId = (args.unitId ?? args.orderId)?.toString() || '0';
    const tierId = Number(args.tierId ?? args.packageId ?? 0);
    const amount = args.amount;
    const unlockTime = args.unlockTime;

    const usdt = formatUsdt(amount);
    const label = pkgLabel(tierId);
    const maturesDate = new Date(Number(unlockTime) * 1000).toUTCString();
    const expectedRise = (Number(ethers.formatUnits(amount, 18)) * 1.10).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
    const userLower = user.toLowerCase();

    const subs = getSubscribers();
    const sub = subs[userLower];
    if (sub) {
        const dm = [
            `🤝 <b>[RISEUP2U] MUTUAL SUPPORT EXTENDED!</b>`,
            `━━━━━━━━━━━━━━━━━━`,
            `👤 <b>Member:</b> <code>${shorten(user)}</code>`,
            `📦 <b>Package:</b> ${label}`,
            `🔢 <b>Unit ID:</b> #${unitId}`,
            `⏱️ <b>Cycle Lock:</b> 10 Days (240 Hours)`,
            `⏰ <b>Matures:</b> ${maturesDate}`,
            `📈 <b>Expected Rise:</b> $${expectedRise} USDT (Principal + 10% Community Benefit)`,
            `⛓️ <b>Tx:</b> ${linkTx(txHash)}`,
            `━━━━━━━━━━━━━━━━━━`,
            `⚡ <i>Your support is active and empowering communal velocity!</i>`
        ].join('\n');
        queueTelegramMessage(dm, sub.chatId);
    }

    const channelMsg = [
        `🤝 <b>[RISEUP2U] MUTUAL SUPPORT EXTENDED!</b>`,
        `━━━━━━━━━━━━━━━━━━`,
        `👤 <b>Member:</b> ${linkAddr(user)}`,
        `📦 <b>Package:</b> ${label}`,
        `🔢 <b>Unit ID:</b> #${unitId}`,
        `⏱️ <b>Cycle Lock:</b> 10 Days (240 Hours)`,
        `⏰ <b>Matures:</b> ${maturesDate}`,
        `📈 <b>Expected Rise:</b> $${expectedRise} USDT (Principal + 10% Community Benefit)`,
        `⛓️ <b>Tx:</b> ${linkTx(txHash)}`,
        `━━━━━━━━━━━━━━━━━━`,
        `⚡ <b>RiseUp2u.com</b> | <i>"Support to Relieve. Unite to Rise."</i>`
    ].join('\n');

    console.log(`[Event] Supported: Unit #${unitId} — $${usdt} USDT by ${shorten(user)} (${label})`);
    queueTelegramMessage(channelMsg, CHANNEL_CHAT_ID);
}

// ── EVENT: Risen (Solidarity Rise Completed) ─────────────────────
function handleRisen(event, txHash) {
    const args = event.args;
    const user = args.user;
    const unitId = (args.unitId ?? args.orderId)?.toString() || '0';
    const principal = args.principal;
    const benefit = args.benefit ?? args.reward ?? 0n;
    const totalPayout = args.totalPayout ?? (principal + benefit);

    const principalUsdt = formatUsdt(principal);
    const benefitUsdt = formatUsdt(benefit);
    const payoutUsdt = formatUsdt(totalPayout);
    const userLower = user.toLowerCase();

    const subs = getSubscribers();
    const sub = subs[userLower];
    if (sub) {
        const dm = [
            `🎉 <b>[RISEUP2U] SOLIDARITY RISE COMPLETED!</b>`,
            `━━━━━━━━━━━━━━━━━━`,
            `🔢 <b>Unit ID:</b> #${unitId}`,
            `💵 <b>Principal:</b> $${principalUsdt} USDT`,
            `📈 <b>Community Benefit (+10%):</b> +$${benefitUsdt} USDT`,
            `💰 <b>Total Payout (110%):</b> $${payoutUsdt} USDT`,
            `⛓️ <b>Tx:</b> ${linkTx(txHash)}`,
            `━━━━━━━━━━━━━━━━━━`,
            `⚡ <i>Congratulations! Your 110% gross payout has been settled directly to your Web3 wallet.</i>`
        ].join('\n');
        queueTelegramMessage(dm, sub.chatId);
    }

    const channelMsg = [
        `🎉 <b>[RISEUP2U] SOLIDARITY RISE COMPLETED!</b>`,
        `━━━━━━━━━━━━━━━━━━`,
        `👤 <b>Member:</b> ${linkAddr(user)}`,
        `🔢 <b>Unit ID:</b> #${unitId}`,
        `💵 <b>Principal:</b> $${principalUsdt} USDT`,
        `📈 <b>Community Benefit (+10%):</b> +$${benefitUsdt} USDT`,
        `💰 <b>Total Payout (110%):</b> $${payoutUsdt} USDT`,
        `⛓️ <b>Tx:</b> ${linkTx(txHash)}`,
        `━━━━━━━━━━━━━━━━━━`,
        `⚡ <b>RiseUp2u.com</b> | <i>Mutual Solidarity Payout Settled</i>`
    ].join('\n');

    console.log(`[Event] Risen: Unit #${unitId} — $${payoutUsdt} USDT payout to ${shorten(user)}`);
    queueTelegramMessage(channelMsg, CHANNEL_CHAT_ID);
}

// ── EVENT: ReSupported (1-Click Re-Support & Rise) ───────────────
function handleReSupported(event, txHash) {
    const args = event.args;
    const user = args.user;
    const oldUnitId = (args.oldUnitId ?? args.oldOrderId)?.toString() || '0';
    const newUnitId = (args.newUnitId ?? args.newOrderId)?.toString() || '0';
    const amount = args.amount;

    const usdt = formatUsdt(amount);
    const payoutTotal = (Number(ethers.formatUnits(amount, 18)) * 1.10).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
    const userLower = user.toLowerCase();

    const subs = getSubscribers();
    const sub = subs[userLower];
    if (sub) {
        const dm = [
            `🔄 <b>[RISEUP2U] 1-CLICK RE-SUPPORT & RISE EXECUTED!</b>`,
            `━━━━━━━━━━━━━━━━━━`,
            `📤 <b>Retired Unit:</b> #${oldUnitId}`,
            `✨ <b>New Support Unit:</b> #${newUnitId} ($${usdt} USDT)`,
            `💵 <b>Total Payout Sent:</b> $${payoutTotal} USDT (Transferred directly to wallet!)`,
            `⛓️ <b>Tx:</b> ${linkTx(txHash)}`,
            `━━━━━━━━━━━━━━━━━━`,
            `⚡ <i>+10% Community Benefit claimed. Principal automatically rolled over into the next 240-hour cycle!</i>`
        ].join('\n');
        queueTelegramMessage(dm, sub.chatId);
    }

    const channelMsg = [
        `🔄 <b>[RISEUP2U] RE-SUPPORT & RISE EXECUTED!</b>`,
        `━━━━━━━━━━━━━━━━━━`,
        `👤 <b>Member:</b> ${linkAddr(user)}`,
        `📦 <b>Retired Unit:</b> #${oldUnitId}`,
        `✨ <b>New Support Unit:</b> #${newUnitId} ($${usdt} USDT)`,
        `💵 <b>Total Payout Sent:</b> $${payoutTotal} USDT (Transferred directly to wallet!)`,
        `⛓️ <b>Tx:</b> ${linkTx(txHash)}`,
        `━━━━━━━━━━━━━━━━━━`,
        `⚡ <b>RiseUp2u.com</b> | <i>Perpetual Autonomous Solidarity Loop</i>`
    ].join('\n');

    console.log(`[Event] ReSupported: Unit #${oldUnitId} → #${newUnitId} ($${usdt} USDT) for ${shorten(user)}`);
    queueTelegramMessage(channelMsg, CHANNEL_CHAT_ID);
}

// ── EVENT: HostRegistered (Community Host Welcomed) ──────────────
function handleHostRegistered(event, txHash) {
    const args = event.args;
    const user = args.user;
    const host = args.host ?? args.sponsor;
    const hostLower = host.toLowerCase();

    // Index to persistent network tree cache
    saveNetworkRegistration(user, host, txHash, event.log?.blockNumber);

    const subs = getSubscribers();
    const hostSub = subs[hostLower];
    if (hostSub) {
        const dm = [
            `🤝 <b>[RISEUP2U] NEW MEMBER WELCOMED UNDER YOU!</b>`,
            `━━━━━━━━━━━━━━━━━━`,
            `👤 <b>New Member:</b> ${linkAddr(user)}`,
            `👑 <b>Your Wallet:</b> <code>${shorten(host)}</code>`,
            `⛓️ <b>Tx:</b> ${linkTx(txHash)}`,
            `━━━━━━━━━━━━━━━━━━`,
            `⚡ <i>You are their Community Host. Guide them to extend mutual support and unlock 10-Tier Community Shares!</i>`
        ].join('\n');
        console.log(`[Personal DM] Sending new member welcome alert to Community Host: ${hostSub.chatId}`);
        queueTelegramMessage(dm, hostSub.chatId);
    }

    const channelMsg = [
        `🤝 <b>[RISEUP2U] NEW COMMUNITY MEMBER WELCOMED!</b>`,
        `━━━━━━━━━━━━━━━━━━`,
        `👤 <b>New Member:</b> ${linkAddr(user)}`,
        `👑 <b>Community Host:</b> ${linkAddr(host)}`,
        `⛓️ <b>Tx:</b> ${linkTx(txHash)}`,
        `━━━━━━━━━━━━━━━━━━`,
        `⚡ <b>RiseUp2u.com</b> | <i>"Support to Relieve. Unite to Rise."</i>`
    ].join('\n');

    console.log(`[Event] HostRegistered: ${shorten(user)} welcomed by Community Host ${shorten(host)}`);
    queueTelegramMessage(channelMsg, CHANNEL_CHAT_ID);
}

// ── EVENT: CommunityShareCredited (10-Tier Cascade Grant) ─────────
function handleCommunityShareCredited(event, txHash) {
    const args = event.args;
    const upline = args.upline;
    const fromUser = args.fromUser;
    const tier = args.tier ?? (Number(args.level ?? 0) + 1);
    const amount = args.amount;

    const usdt = formatUsdt(amount);
    const tierNum = Number(tier);
    const uplineLower = upline.toLowerCase();
    const tierLabel = tierNum === 1 ? 'Tier 1 (Direct Host Grant)' : `Tier ${tierNum}`;

    const subs = getSubscribers();
    const sub = subs[uplineLower];
    if (sub) {
        const dm = [
            `💎 <b>[RISEUP2U] COMMUNITY SHARE RECEIVED!</b>`,
            `━━━━━━━━━━━━━━━━━━`,
            `👑 <b>Recipient:</b> <code>${shorten(upline)}</code>`,
            `🎁 <b>Grant Amount:</b> +$${usdt} USDT`,
            `🏆 <b>Generation:</b> ${tierLabel}`,
            `👥 <b>From Member:</b> ${linkAddr(fromUser)}`,
            `⛓️ <b>Tx:</b> ${linkTx(txHash)}`,
            `━━━━━━━━━━━━━━━━━━`,
            `⚡ <i>Grant added to your claimable balance. Rise anytime from Community Portal (min 10 USDT).</i>`
        ].join('\n');
        console.log(`[Personal DM] Community Share Tier ${tierNum} +$${usdt} to Chat ID: ${sub.chatId}`);
        queueTelegramMessage(dm, sub.chatId);
    }

    const channelMsg = [
        `💎 <b>[RISEUP2U] COMMUNITY SHARE GRANTED!</b>`,
        `━━━━━━━━━━━━━━━━━━`,
        `👑 <b>Recipient:</b> ${linkAddr(upline)}`,
        `🏆 <b>Generation:</b> ${tierLabel}`,
        `🎁 <b>Grant Amount:</b> +$${usdt} USDT`,
        `👥 <b>From Member:</b> ${linkAddr(fromUser)}`,
        `⛓️ <b>Tx:</b> ${linkTx(txHash)}`,
        `━━━━━━━━━━━━━━━━━━`,
        `⚡ <b>RiseUp2u.com</b> | <i>10-Tier Community Share Engine</i>`
    ].join('\n');

    console.log(`[Event] CommunityShareCredited: Tier ${tierNum} +$${usdt} → ${shorten(upline)} from ${shorten(fromUser)}`);
    queueTelegramMessage(channelMsg, CHANNEL_CHAT_ID);
}

// ── EVENT: CommunityShareRisen (Grants Claimed) ──────────────────
function handleCommunityShareRisen(event, txHash) {
    const args = event.args;
    const user = args.user;
    const amount = args.amount;
    const usdt = formatUsdt(amount);
    const userLower = user.toLowerCase();

    const subs = getSubscribers();
    const sub = subs[userLower];
    if (sub) {
        const dm = [
            `✅ <b>[RISEUP2U] COMMUNITY SHARES RISEN!</b>`,
            `━━━━━━━━━━━━━━━━━━`,
            `💵 <b>Amount Risen:</b> $${usdt} USDT`,
            `⛓️ <b>Tx:</b> ${linkTx(txHash)}`,
            `━━━━━━━━━━━━━━━━━━`,
            `⚡ <i>Your community share grants have been settled directly to your wallet!</i>`
        ].join('\n');
        queueTelegramMessage(dm, sub.chatId);
    }

    const channelMsg = [
        `✅ <b>[RISEUP2U] COMMUNITY SHARES RISEN!</b>`,
        `━━━━━━━━━━━━━━━━━━`,
        `👤 <b>Member:</b> ${linkAddr(user)}`,
        `💵 <b>Amount Risen:</b> $${usdt} USDT`,
        `⛓️ <b>Tx:</b> ${linkTx(txHash)}`,
        `━━━━━━━━━━━━━━━━━━`,
        `⚡ <b>RiseUp2u.com</b> | <i>10-Tier Community Share Engine</i>`
    ].join('\n');

    console.log(`[Event] CommunityShareRisen: $${usdt} USDT by ${shorten(user)}`);
    queueTelegramMessage(channelMsg, CHANNEL_CHAT_ID);
}

// ── EVENT: CommunityShareBreakageRetained (Reinforces Liquidity) ─
function handleCommunityShareBreakageRetained(event, txHash) {
    const args = event.args;
    const fromUser = args.fromUser;
    const tier = args.tier ?? (Number(args.level ?? 0) + 1);
    const amount = args.amount;

    const usdt = formatUsdt(amount);
    const tierNum = Number(tier);

    const channelMsg = [
        `🛡️ <b>[RISEUP2U] VAULT BREAKAGE RETAINED</b>`,
        `━━━━━━━━━━━━━━━━━━`,
        `👤 <b>From Member:</b> ${linkAddr(fromUser)}`,
        `🏆 <b>Generation:</b> Tier ${tierNum} (Unqualified Host)`,
        `💵 <b>Retained Liquidity:</b> +$${usdt} USDT`,
        `⛓️ <b>Tx:</b> ${linkTx(txHash)}`,
        `━━━━━━━━━━━━━━━━━━`,
        `⚡ <i>Retained in Vault to reinforce communal claim liquidity reserves!</i>`
    ].join('\n');

    console.log(`[Event] CommunityShareBreakageRetained: Tier ${tierNum} +$${usdt} USDT from ${shorten(fromUser)}`);
    queueTelegramMessage(channelMsg, CHANNEL_CHAT_ID);
}

// ── EVENT: CommunityReservePaid (Protocol Resilience Vault) ──────
function handleCommunityReservePaid(event, txHash) {
    const args = event.args;
    const treasury = args.treasury;
    const amount = args.amount;
    const usdt = formatUsdt(amount);
    console.log(`[Event] CommunityReservePaid: $${usdt} USDT → Treasury ${shorten(treasury)}`);
}

// ── EVENT: LiquidityInjected (Vault Capital Inflow) ──────────────
function handleLiquidityInjected(event, txHash) {
    const args = event.args;
    const provider = args.provider;
    const amount = args.amount;
    const usdt = formatUsdt(amount);

    const channelMsg = [
        `💧 <b>[RISEUP2U] VAULT LIQUIDITY INJECTED!</b>`,
        `━━━━━━━━━━━━━━━━━━`,
        `👤 <b>Provider:</b> ${linkAddr(provider)}`,
        `💵 <b>Amount Injected:</b> +$${usdt} USDT`,
        `⛓️ <b>Tx:</b> ${linkTx(txHash)}`,
        `━━━━━━━━━━━━━━━━━━`,
        `⚡ <i>Vault resilience and solvency coverage reinforced!</i>`
    ].join('\n');

    console.log(`[Event] LiquidityInjected: +$${usdt} USDT from ${shorten(provider)}`);
    queueTelegramMessage(channelMsg, CHANNEL_CHAT_ID);
}

// --- 5. TELEGRAM INCOMING COMMANDS POLLER (/start 0x...) ---
let lastUpdateId = 0;

async function pollTelegramUpdates() {
    if (!BOT_TOKEN) return;

    try {
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=15`;
        const res = await fetch(url);
        const data = await res.json();

        if (data.ok && Array.isArray(data.result)) {
            for (const update of data.result) {
                lastUpdateId = update.update_id;

                if (update.message && update.message.text) {
                    const chatId = update.message.chat.id;
                    const text = update.message.text.trim();
                    const fromUser = update.message.from || {};

                    // Handle /start or /link with wallet parameter:
                    // e.g. "/start 0xFDF5B6986ee0AF2Ab5941C581F9eB641B52A9ED0"
                    const walletMatch = text.match(/0x[a-fA-F0-9]{40}/i);

                    if (walletMatch) {
                        const rawWallet = walletMatch[0];
                        try {
                            const checksummed = ethers.getAddress(rawWallet);
                            saveSubscriber(checksummed, {
                                chatId,
                                username: fromUser.username || '',
                                firstName: fromUser.first_name || '',
                                wallet: checksummed
                            });

                            const reply = [
                                `🎉 <b>RISEUP2U WALLET ALERTS ACTIVATED!</b>`,
                                `━━━━━━━━━━━━━━━━━━`,
                                `✅ <b>Wallet:</b> <code>${checksummed}</code>`,
                                `🔔 <b>Status:</b> <b>ACTIVE 24/7</b>`,
                                `━━━━━━━━━━━━━━━━━━`,
                                `<b>Automatic Push Notifications:</b>`,
                                `You will receive instant real-time alerts whenever your mutual support units mature (+10% Community Benefit), community share grants are credited, or rollovers are executed on BNB Smart Chain.`,
                                `━━━━━━━━━━━━━━━━━━`,
                                `⚡ <i>Dashboard: <a href="https://riseup2u.com/dashboard/">riseup2u.com/dashboard/</a></i>`
                            ].join('\n');

                            await sendTelegramRaw(reply, chatId);
                        } catch (e) {
                            await sendTelegramRaw(`❌ Invalid wallet address format: <code>${rawWallet}</code>`, chatId);
                        }
                    } else if (text.startsWith('/stop')) {
                        const unlinked = removeSubscriber(chatId);
                        if (unlinked) {
                            await sendTelegramRaw(`🔕 Notifications for wallet <code>${shorten(unlinked)}</code> have been deactivated.`, chatId);
                        } else {
                            await sendTelegramRaw(`⚠️ No active wallet subscription found for this chat.`, chatId);
                        }
                    } else if (text.startsWith('/status') || text.startsWith('/mywallet')) {
                        const subs = getSubscribers();
                        let found = null;
                        for (const [w, info] of Object.entries(subs)) {
                            if (String(info.chatId) === String(chatId)) {
                                found = w;
                                break;
                            }
                        }
                        if (found) {
                            await sendTelegramRaw(`✅ <b>Status:</b> Wallet <code>${found}</code> is actively receiving 24/7 on-chain alerts!`, chatId);
                        } else {
                            await sendTelegramRaw(`⚠️ No wallet linked yet.\nPlease send:\n<code>/start 0xYourWalletAddress</code>`, chatId);
                        }
                    } else if (text.startsWith('/start') || text.startsWith('/help')) {
                        const welcome = [
                            `👋 <b>Welcome to RiseUp2u Alerts Bot!</b>`,
                            `━━━━━━━━━━━━━━━━━━`,
                            `<b>How to Activate Personal Wallet Alerts:</b>`,
                            `1. Open <b>riseup2u.com/dashboard/</b> (or <a href="https://riseup2u.com">RiseUp2u.com</a>), connect your Web3 wallet, and click <b>"Connect Telegram Bot"</b>.`,
                            `2. OR send your wallet address directly here:`,
                            `   <code>/start 0xYourWalletAddress</code>`,
                            `   <i>(Example: /start 0xFDF5B6986ee0AF2Ab5941C581F9eB641B52A9ED0)</i>`,
                            `━━━━━━━━━━━━━━━━━━`,
                            `🔔 <b>Supported Instant Alerts:</b>`,
                            `• <b>Maturity Payouts:</b> Live notification when your 240-hour cycle yields 110% communal rise`,
                            `• <b>Community Share Grants:</b> Real-time community commission alerts across 10 generations`,
                            `• <b>1-Click Re-Support Rollovers:</b> Confirmation when principal is re-supported into the next cycle`,
                            `━━━━━━━━━━━━━━━━━━`,
                            `📢 <b>Official Channel:</b> @RiseUp2u`,
                            `⚡ <b>DApp Portal:</b> <a href="https://riseup2u.com">riseup2u.com</a>`
                        ].join('\n');
                        await sendTelegramRaw(welcome, chatId);
                    }
                }
            }
        }
    } catch (err) {
        // Silent catch for network hiccups during long polling
    }

    setTimeout(pollTelegramUpdates, 2000);
}

// --- 6. PERSISTENT BLOCK CACHE ---
const CACHE_FILE = path.join(CACHE_DIR, `last_block_${ACTIVE_NET.chainId}.json`);

function getSavedBlock() {
    try {
        if (fs.existsSync(CACHE_FILE)) {
            const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
            if (data && data.lastBlock) return Number(data.lastBlock);
        }
    } catch (e) {
        console.warn('Could not read block cache:', e.message);
    }
    return null;
}

function saveBlock(blockNum) {
    try {
        if (!fs.existsSync(CACHE_DIR)) {
            fs.mkdirSync(CACHE_DIR, { recursive: true });
        }
        fs.writeFileSync(CACHE_FILE, JSON.stringify({ lastBlock: blockNum, updatedAt: new Date().toISOString() }));
    } catch (e) {
        console.warn('Could not save block cache:', e.message);
    }
}

// --- 7. ROBUST RPC PROVIDER WITH AUTO-FAILOVER ---
let currentRpcIndex = 0;

function getProvider() {
    const rpcUrl = ACTIVE_NET.rpcUrls[currentRpcIndex % ACTIVE_NET.rpcUrls.length];
    return new ethers.JsonRpcProvider(rpcUrl, ACTIVE_NET.chainId, {
        batchMaxCount: 1,
        staticNetwork: true
    });
}

function rotateRpc() {
    currentRpcIndex++;
    const nextRpc = ACTIVE_NET.rpcUrls[currentRpcIndex % ACTIVE_NET.rpcUrls.length];
    console.log(`[RPC Failover] Switching to next RPC: ${nextRpc}`);
}

// --- 8. TEST MODE ---
async function runTestMode() {
    console.log(`\n--- RiseUp2u Telegram Alert Test ---`);
    console.log(`Bot Token: ${BOT_TOKEN ? BOT_TOKEN.slice(0, 10) + '...' : 'NOT CONFIGURED'}`);
    console.log(`Target Channel: ${CHANNEL_CHAT_ID}`);
    console.log(`Network: ${ACTIVE_NET.name}`);
    console.log(`Contract: ${ACTIVE_NET.contractAddress}\n`);

    const testMsg = [
        `🤖 <b>RISEUP2U BOT CONNECTION TEST</b>`,
        `━━━━━━━━━━━━━━━━━━`,
        `✅ <b>Status:</b> Telegram On-Chain Listener Connected!`,
        `🌐 <b>Network:</b> ${ACTIVE_NET.name}`,
        `📍 <b>Contract:</b> <code>${ACTIVE_NET.contractAddress}</code>`,
        `🕒 <b>Time:</b> ${new Date().toUTCString()}`,
        `━━━━━━━━━━━━━━━━━━`,
        `⚡ <i>Ready to broadcast live 24/7 on-chain mutual solidarity alerts!</i>`
    ].join('\n');

    console.log('Sending test alert to Telegram...');
    await sendTelegramRaw(testMsg, CHANNEL_CHAT_ID);
    console.log('Test message sent! Check your Telegram channel: ' + CHANNEL_CHAT_ID);
    process.exit(0);
}

// --- 9. MAIN LISTENER LOOP ---
async function startListener() {
    console.log('====================================================');
    console.log('  RiseUp2u 24/7 On-Chain Telegram Event Listener   ');
    console.log('====================================================');
    console.log(`Network:  ${ACTIVE_NET.name} (Chain ID: ${ACTIVE_NET.chainId})`);
    console.log(`Contract: ${ACTIVE_NET.contractAddress}`);
    console.log(`Channel:  ${CHANNEL_CHAT_ID}`);
    console.log(`RPC Node: ${ACTIVE_NET.rpcUrls[0]}\n`);

    if (!BOT_TOKEN) {
        console.error('[Fatal] TELEGRAM_BOT_TOKEN is not set in environment or code. Exiting.');
        process.exit(1);
    }

    if (IS_TEST_MODE) {
        await runTestMode();
        return;
    }

    let provider = getProvider();
    const contractInterface = new ethers.Interface(EVENT_ABI);

    // Initial Block Setup: Start scanning from latest block minus safety buffer
    let lastProcessedBlock = getSavedBlock();
    let latestBlock = 0;
    try {
        latestBlock = await provider.getBlockNumber();
    } catch (e) {
        console.warn('[Init] Primary RPC failed to getBlockNumber, rotating...');
        rotateRpc();
        provider = getProvider();
        latestBlock = await provider.getBlockNumber();
    }

    if (!lastProcessedBlock || lastProcessedBlock > latestBlock || (latestBlock - lastProcessedBlock > 30)) {
        // Start from current block minus 5 blocks for instant real-time sync
        lastProcessedBlock = Math.max(0, latestBlock - 5);
        saveBlock(lastProcessedBlock);
    }

    console.log(`[Listener Initialized] Starting block scan from #${lastProcessedBlock.toLocaleString()} (Latest: #${latestBlock.toLocaleString()})`);
    console.log(`[Bot Polling Initialized] Listening for /start <wallet> incoming links...\n`);

    // Start background Telegram updates poller
    pollTelegramUpdates();

    const POLL_INTERVAL_MS = 4000; // 4 seconds
    let currentChunkBlocks = 10; // Start with safe small 10-block chunk
    const MIN_CHUNK = 3;

    const runScanLoop = async () => {
        try {
            const currentBlock = await provider.getBlockNumber();
            const safeCurrentBlock = Math.max(0, currentBlock - 2);

            if (safeCurrentBlock > lastProcessedBlock) {
                const fromBlock = lastProcessedBlock + 1;
                const toBlock = Math.min(fromBlock + currentChunkBlocks, safeCurrentBlock);

                // Query all contract logs in this block window with clean checksummed address
                const targetAddress = cleanAddress(ACTIVE_NET.contractAddress);
                const logs = await provider.getLogs({
                    address: targetAddress,
                    fromBlock,
                    toBlock
                });

                if (logs.length > 0) {
                    console.log(`[Blocks #${fromBlock} - #${toBlock}] Found ${logs.length} on-chain event(s)!`);

                    for (const log of logs) {
                        try {
                            const parsed = contractInterface.parseLog(log);
                            if (!parsed) continue;

                            switch (parsed.name) {
                                // ── RiseUp2u Support & Rise Native Events ──
                                case 'Supported':
                                case 'Committed':
                                    handleSupported(parsed, log.transactionHash);
                                    break;
                                case 'Risen':
                                case 'Claimed':
                                    handleRisen(parsed, log.transactionHash);
                                    break;
                                case 'ReSupported':
                                case 'Recommitted':
                                    handleReSupported(parsed, log.transactionHash);
                                    break;
                                case 'HostRegistered':
                                case 'SponsorRegistered':
                                    handleHostRegistered(parsed, log.transactionHash);
                                    break;
                                case 'CommunityShareCredited':
                                case 'UnilevelCredited':
                                    handleCommunityShareCredited(parsed, log.transactionHash);
                                    break;
                                case 'CommunityShareRisen':
                                case 'SolidarityRisen':
                                case 'UnilevelClaimed':
                                    handleCommunityShareRisen(parsed, log.transactionHash);
                                    break;
                                case 'CommunityShareBreakageRetained':
                                case 'UnilevelBreakageRetained':
                                    handleCommunityShareBreakageRetained(parsed, log.transactionHash);
                                    break;
                                case 'CommunityReservePaid':
                                case 'ProtocolReservePaid':
                                    handleCommunityReservePaid(parsed, log.transactionHash);
                                    break;
                                case 'LiquidityInjected':
                                    handleLiquidityInjected(parsed, log.transactionHash);
                                    break;
                                default:
                                    break;
                            }
                        } catch (err) {
                            // Log not from our interface or parse error
                        }
                    }
                }

                lastProcessedBlock = toBlock;
                saveBlock(lastProcessedBlock);
            }
        } catch (err) {
            console.warn(`[Scan Error at Block #${lastProcessedBlock}]:`, err.message || err);
            // Downscale chunk size immediately to prevent limit exceeded errors
            currentChunkBlocks = MIN_CHUNK;
            rotateRpc();
            provider = getProvider();
        }

        setTimeout(runScanLoop, POLL_INTERVAL_MS);
    };

    runScanLoop();
}

// Global Process Handlers for clean termination
process.on('SIGINT', () => {
    console.log('\n[Listener Stopped] Exiting gracefully...');
    process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[Unhandled Promise Rejection]:', reason);
});

startListener();
