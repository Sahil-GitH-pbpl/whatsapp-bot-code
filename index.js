require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { initDatabase, pool } = require('./utils/db');
const storage = require('./services/storage');
const AccountManager = require('./services/accountManager');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// Serve QRCode library from version-controlled vendor assets
app.use('/vendor', express.static(path.join(__dirname, 'public', 'vendor')));

// Handle bad JSON payloads cleanly instead of crashing downstream handlers
app.use((err, _req, res, next) => {
    if (err instanceof SyntaxError && 'body' in err) {
        console.error('Invalid JSON payload', err.message);
        return res.status(400).json({ error: 'Invalid JSON' });
    }
    next(err);
});

const sseClients = new Set();
const broadcast = (event, payload) => {
    const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    sseClients.forEach((res) => res.write(data));
};

const manager = new AccountManager(broadcast);

function buildSendLockKey(accountId, target, message, media) {
    const normalizedTarget = String(target || '').trim();
    const mediaHint = media ? `${media.mimetype || ''}:${media.filename || ''}` : '';
    const normalizedMsg = String(message || '').trim();
    const hash = crypto.createHash('sha1').update(`${accountId}|${normalizedTarget}|${normalizedMsg}|${mediaHint}`).digest('hex');
    return `send:${hash}`; // <= 64 chars for MySQL named lock
}

async function withSendLock(accountId, target, message, media, fn) {
    const key = buildSendLockKey(accountId, target, message, media);
    const [rows] = await pool.query('SELECT GET_LOCK(?, 2) AS locked', [key]);
    const locked = rows?.[0]?.locked;
    if (locked !== 1) {
        throw new Error('Duplicate send in progress');
    }
    try {
        return await fn();
    } finally {
        await pool.query('DO RELEASE_LOCK(?)', [key]);
    }
}

function parseAccount(row) {
    return {
        id: row.id,
        label: row.label,
        phoneNumber: row.phone_number,
        status: row.status,
        skipHistoryBeforeReady: !!row.skip_history_before_ready,
        lastReadyAt: row.last_ready_at ? Number(row.last_ready_at) : null,
        hasQr: Boolean(row.last_qr),
        createdAt: row.created_at
    };
}

app.get('/api/accounts', async (_req, res) => {
    const accounts = await storage.getAccounts();
    res.json({ items: accounts.map(parseAccount) });
});

app.post('/api/accounts', async (req, res) => {
    const { label } = req.body || {};
    if (!label || !label.trim()) {
        return res.status(400).json({ error: 'Label is required' });
    }
    try {
        const account = await manager.createAccount(label.trim());
        res.status(201).json(parseAccount(account));
    } catch (err) {
        const status = err.message === 'Duplicate send in progress' ? 429 : 500;
        res.status(status).json({ error: err.message });
    }
});

app.patch('/api/accounts/:accountId/preferences', async (req, res) => {
    const accountId = Number(req.params.accountId);
    const { skipHistoryBeforeReady } = req.body || {};
    const account = await storage.getAccountById(accountId);
    if (!account) {
        return res.status(404).json({ error: 'Account not found' });
    }
    const nextSkip = !!skipHistoryBeforeReady;
    const updates = { skip_history_before_ready: nextSkip ? 1 : 0 };
    // When enabling skip on a ready account, pin the cutoff to now so old messages are ignored immediately.
    if (nextSkip && account.status === 'ready') {
        updates.last_ready_at = Date.now();
    }
    await storage.updateAccount(accountId, updates);
    manager.setSkipHistory(accountId, nextSkip, updates.last_ready_at);
    const updated = await storage.getAccountById(accountId);
    res.json(parseAccount(updated));
});

app.get('/api/accounts/:accountId/status', async (req, res) => {
    const accountId = Number(req.params.accountId);
    const account = await storage.getAccountById(accountId);
    if (!account) {
        return res.status(404).json({ error: 'Account not found' });
    }
    res.json({
        ...parseAccount(account),
        qr: manager.getQr(accountId) || account.last_qr || null
    });
});

app.get('/api/accounts/:accountId/qr', async (req, res) => {
    const accountId = Number(req.params.accountId);
    const account = await storage.getAccountById(accountId);
    if (!account) {
        return res.status(404).json({ error: 'Account not found' });
    }
    const qr = manager.getQr(accountId) || account.last_qr;
    if (!qr) {
        return res.status(404).json({ error: 'QR not available' });
    }
    let qrImage = null;
    try {
        qrImage = await QRCode.toDataURL(qr, { width: 240 });
    } catch (_err) {
        qrImage = null;
    }
    res.json({ qr, qrImage });
});

app.get('/api/accounts/:accountId/chats', async (req, res) => {
    const accountId = Number(req.params.accountId);
    const account = await storage.getAccountById(accountId);
    if (!account) {
        return res.status(404).json({ error: 'Account not found' });
    }
    const chats = await storage.getChats(accountId);
    res.json({ items: chats });
});

app.get('/api/accounts/:accountId/chats/:chatId/messages', async (req, res) => {
    const accountId = Number(req.params.accountId);
    const chatId = decodeURIComponent(req.params.chatId || '').trim();
    const limitRaw = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(limitRaw)
        ? Math.min(Math.max(limitRaw, 1), 200)
        : 50;

    const account = await storage.getAccountById(accountId);
    if (!account) {
        return res.status(404).json({ error: 'Account not found' });
    }

    try {
        let messages = await storage.getMessages(accountId, chatId, limit);
        if (!messages.length) {
            try {
                messages = await manager.fetchAndStoreMessages(accountId, chatId, limit);
            } catch (_err) {
                // Ignore chat history refresh errors; UI will display existing data
            }
        }
        res.json({ chatId, messages });
    } catch (err) {
        console.error('Failed to load messages', err.message);
        res.status(500).json({ error: 'Unable to load messages' });
    }
});

app.post('/api/accounts/:accountId/send', async (req, res) => {
    const accountId = Number(req.params.accountId);
    const { target, message, media } = req.body || {};

    if (!target || (!message || !message.trim()) && !media) {
        return res.status(400).json({ error: 'Target and message or media are required' });
    }

    const account = await storage.getAccountById(accountId);
    if (!account) {
        return res.status(404).json({ error: 'Account not found' });
    }
    if (account.status !== 'ready') {
        return res.status(409).json({ error: 'Account not ready' });
    }

    try {
        if (!manager.getClient(accountId)) {
            return res.status(409).json({ error: 'Account client not connected' });
        }
        await withSendLock(accountId, target, message, media, () =>
            manager.sendMessage(accountId, target, message, media)
        );
        res.json({ success: true });
    } catch (err) {
        const status = err.message === 'Duplicate send in progress'
            ? 429
            : (err.statusCode || 500);
        res.status(status).json({ error: err?.message || String(err) || 'Send failed' });
    }
});

// Send message (text or media) specifying account in payload
app.post('/api/messages/send', async (req, res) => {
    const { accountId, target, message, media } = req.body || {};
    const numericAccountId = Number(accountId);

    if (!numericAccountId || !target || (!message || !message.trim()) && !media) {
        return res.status(400).json({ error: 'accountId, target, and message or media are required' });
    }

    const account = await storage.getAccountById(numericAccountId);
    if (!account) {
        return res.status(404).json({ error: 'Account not found' });
    }
    if (account.status !== 'ready') {
        return res.status(409).json({ error: 'Account not ready' });
    }

    try {
        if (!manager.getClient(numericAccountId)) {
            return res.status(409).json({ error: 'Account client not connected' });
        }
        await withSendLock(numericAccountId, target, message, media, () =>
            manager.sendMessage(numericAccountId, target, message, media)
        );
        res.json({ success: true });
    } catch (err) {
        const status = err.message === 'Duplicate send in progress'
            ? 429
            : (err.statusCode || 500);
        res.status(status).json({ error: err?.message || String(err) || 'Send failed' });
    }
});

app.get('/api/accounts/:accountId/messages/:messageId/media', async (req, res) => {
    const accountId = Number(req.params.accountId);
    const messageId = Number(req.params.messageId);

    const media = await storage.getMessageMedia(accountId, messageId);
    if (!media || !media.mediaData) {
        return res.status(404).json({ error: 'Media not found' });
    }

    const buffer = Buffer.from(media.mediaData, 'base64');
    res.setHeader('Content-Type', media.mediaMime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${media.mediaFilename || 'attachment'}"`);
    res.send(buffer);
});

app.get('/api/events', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    sseClients.add(res);
    const accounts = await storage.getAccounts();
    res.write(`event: status\ndata: ${JSON.stringify({ accounts: accounts.map(parseAccount) })}\n\n`);

    req.on('close', () => {
        sseClients.delete(res);
    });
});

app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) {
        return next();
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let server;

async function bootstrap() {
    await initDatabase();
    await manager.bootstrap();
    server = app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
}

bootstrap().catch((err) => {
    console.error('Failed to bootstrap application', err);
    process.exit(1);
});

process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    if (server) server.close();
    await manager.shutdown();
    process.exit(0);
});
