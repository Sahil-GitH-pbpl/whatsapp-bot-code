const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const storage = require('./storage');
const AutomationService = require('./automation');
const QRCode = require('qrcode');

const SESSION_BASE = path.join(__dirname, '..', 'data', 'session');
const OUTGOING_MEDIA_ROOT = path.join(__dirname, '..', 'data', 'outgoing-media');
const HEADLESS = (process.env.WWEB_HEADLESS || 'true') !== 'false';
const TARGET_CLOSED_PATTERN = /target closed|session closed|execution context was destroyed|runtime\.callfunctionon/i;
const INIT_RETRYABLE_PATTERN = /navigating frame was detached|lifecyclewatcher terminated|target closed|protocol error|timed out|browser is already running|resource busy|ebusy/i;
const INIT_MAX_RETRIES = Number(process.env.WWEB_INIT_MAX_RETRIES || 4);
const INIT_RETRY_DELAY_MS = Number(process.env.WWEB_INIT_RETRY_DELAY_MS || 3000);
const INIT_TIMEOUT_MS = Number(process.env.WWEB_INIT_TIMEOUT_MS || 90000);
const LOCAL_AUTH_RM_MAX_RETRIES = Number(process.env.WWEB_LOCALAUTH_RM_MAX_RETRIES || 20);
const WINDOWS_LOCKED_FILE_PATTERN = /ebusy|eperm|resource busy or locked/i;
const STATUS_BROADCAST_ID = 'status@broadcast';
const MAX_STORED_MEDIA_BYTES = Number(process.env.WAPP_MAX_STORED_MEDIA_BYTES || 512 * 1024);
const IGNORED_WA_RESPONSE_PATTERNS = [
    'crashlogs.whatsapp.net/wa_fls_upload_check'
];
const IGNORED_WA_CONSOLE_PATTERNS = [
    'dit.whatsapp.net/deidentified_telemetry',
    'Failed to load resource: net::ERR_FAILED'
];
const DEFAULT_COUNTRY_CODE = String(process.env.WAPP_DEFAULT_COUNTRY_CODE || '91').replace(/\D+/g, '') || '91';
const LABMATE_PUBLIC_HOST = 'labmate.bhasinpathlabs.com';
const LABMATE_DOWNLOAD_FALLBACK_HOST = '10.1.1.252';

class ResilientLocalAuth extends LocalAuth {
    async logout() {
        try {
            await super.logout();
        } catch (err) {
            const message = err?.message || String(err);
            if (process.platform === 'win32' && WINDOWS_LOCKED_FILE_PATTERN.test(message)) {
                console.warn('[manager] LocalAuth logout cleanup skipped due a locked profile file');
                return;
            }
            throw err;
        }
    }
}

class AccountManager {
    constructor(broadcast) {
        this.broadcast = broadcast;
        this.clients = new Map();
        this.qrCodes = new Map();
        this.accountMeta = new Map(); // { skipHistoryBeforeReady, lastReadyAt }
        this.automation = new AutomationService();
        this.readyTimers = new Map();
        this.initializeRetries = new Map();
        this.restartTimers = new Map();
    }

    resolveChatName(chat, contact = null) {
        if (!chat) return 'Unknown';
        if (chat.name) return chat.name;
        if (chat.formattedTitle) return chat.formattedTitle;
        if (chat.isGroup && chat.groupMetadata?.subject) {
            return chat.groupMetadata.subject;
        }
        const contactName = contact
            ? (contact.pushname || contact.shortName || contact.name)
            : null;
        if (contactName) return contactName;
        if (chat.contact) {
            const fallback = chat.contact.pushname || chat.contact.shortName || chat.contact.name;
            if (fallback) return fallback;
        }
        return chat.id?.user || 'Unknown';
    }

    removeProfileLocks(root) {
        try {
            const entries = fs.readdirSync(root, { withFileTypes: true });
            for (const entry of entries) {
                const full = path.join(root, entry.name);
                if (entry.isDirectory()) {
                    this.removeProfileLocks(full);
                } else if (entry.name.startsWith('Singleton')) {
                    try {
                        fs.unlinkSync(full);
                    } catch (_err) {
                        // Ignore lock cleanup failures
                    }
                }
            }
        } catch (err) {
            // Ignore directory traversal failures
        }
    }

    async bootstrap() {
        if (!fs.existsSync(SESSION_BASE)) {
            fs.mkdirSync(SESSION_BASE, { recursive: true });
        }

        const accounts = await storage.getAccounts();
        for (const account of accounts) {
            await this.startAccount(account);
        }
    }

    async createAccount(label) {
        const account = await storage.createAccount(label);
        this.accountMeta.set(account.id, {
            skipHistoryBeforeReady: false,
            lastReadyAt: null
        });
        await this.startAccount(account);
        return account;
    }

    getClient(accountId) {
        return this.clients.get(Number(accountId));
    }

    getQr(accountId) {
        return this.qrCodes.get(Number(accountId));
    }

    async startAccount(account) {
        const accountId = Number(account.id);
        const pendingRestart = this.restartTimers.get(accountId);
        if (pendingRestart) {
            clearTimeout(pendingRestart);
            this.restartTimers.delete(accountId);
        }
        if (this.clients.has(accountId)) {
            return this.clients.get(accountId);
        }

        const authId = account.session_folder;
        const dataPath = path.join(SESSION_BASE, authId);
        if (!fs.existsSync(dataPath)) {
            fs.mkdirSync(dataPath, { recursive: true });
        }
        this.removeProfileLocks(dataPath);

        const initialMeta = this.accountMeta.get(accountId) || {};
        let lastReadyAt = account.last_ready_at ? Number(account.last_ready_at) : null;
        if (!lastReadyAt && account.skip_history_before_ready) {
            lastReadyAt = Date.now();
            await storage.updateAccount(accountId, { last_ready_at: lastReadyAt });
        }
        this.accountMeta.set(accountId, {
            skipHistoryBeforeReady: initialMeta.skipHistoryBeforeReady ?? !!account.skip_history_before_ready,
            lastReadyAt
        });

        await storage.updateAccount(accountId, { status: 'initializing' });
        this.broadcastStatus(accountId, 'initializing');

        const clientConfig = {
            authStrategy: new ResilientLocalAuth({
                clientId: authId,
                dataPath,
                rmMaxRetries: LOCAL_AUTH_RM_MAX_RETRIES
            }),
            puppeteer: {
                headless: HEADLESS,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--no-proxy-server',
                    '--proxy-server="direct://"',
                    '--proxy-bypass-list=*',
                    '--disable-extensions',
                    '--no-first-run',
                    '--no-default-browser-check'
                ],
                defaultViewport: null
            },
        };

        // Only pin a web version if explicitly provided; otherwise let whatsapp-web.js resolve a compatible version.
        if (process.env.WWEB_VERSION) {
            clientConfig.webVersion = process.env.WWEB_VERSION;
            clientConfig.webVersionCache = {
                type: (process.env.WWEB_VERSION_CACHE || 'local').toLowerCase(),
                path: path.join(__dirname, '..', '.wwebjs_cache')
            };
        }

        const client = new Client(clientConfig);

        this.attachEvents(client, accountId);
        this.attachPuppeteerDebug(client, accountId);
        this.clients.set(accountId, client);

        let initializePromise;
        try {
            initializePromise = this.initializeClient(client, accountId);
        } catch (err) {
            await this.handleInitializeFailure(accountId, client, err);
            return null;
        }

        Promise.resolve(initializePromise).catch((err) => {
            this.handleInitializeFailure(accountId, client, err).catch((handlerErr) => {
                console.error(`[manager] account ${accountId} init failure handler crashed`, handlerErr.message);
            });
        });

        return client;
    }

    normalizeDisconnectReason(reason) {
        if (typeof reason === 'string') return reason;
        if (reason && typeof reason === 'object' && reason.message) return String(reason.message);
        return String(reason || 'UNKNOWN');
    }

    isStatusBroadcast(chatId) {
        return chatId === STATUS_BROADCAST_ID;
    }

    async destroyClientSafely(accountId, client, context) {
        try {
            await client.destroy();
        } catch (err) {
            const message = err?.message || String(err);
            console.warn(`[manager] account ${accountId} ${context} destroy skipped (${message})`);
        }
    }

    scheduleRestart(accountId, delayMs) {
        const existing = this.restartTimers.get(accountId);
        if (existing) {
            clearTimeout(existing);
        }

        const timeout = setTimeout(async () => {
            this.restartTimers.delete(accountId);
            try {
                if (this.clients.has(accountId)) return;
                const account = await storage.getAccountById(accountId);
                if (!account) return;
                await this.startAccount(account);
            } catch (restartErr) {
                console.error(`[manager] account ${accountId} restart failed`, restartErr.message);
            }
        }, delayMs);

        this.restartTimers.set(accountId, timeout);
    }

    async initializeClient(client, accountId) {
        let timeout;
        try {
            await Promise.race([
                client.initialize(),
                new Promise((_, reject) => {
                    timeout = setTimeout(() => {
                        reject(new Error(`Initialize timed out after ${INIT_TIMEOUT_MS}ms`));
                    }, INIT_TIMEOUT_MS);
                })
            ]);
        } finally {
            clearTimeout(timeout);
        }
        console.log(`[manager] account ${accountId} initialize call completed`);
    }

    async handleInitializeFailure(accountId, client, err) {
        const message = err?.message || String(err);
        console.error(`[manager] account ${accountId} initialize failed`, message);

        this.clearReadyWarning(accountId);
        this.qrCodes.delete(accountId);
        if (this.clients.get(accountId) === client) {
            this.clients.delete(accountId);
        }

        try {
            await storage.updateAccount(accountId, { status: 'error' });
            this.broadcastStatus(accountId, 'error', { reason: message, hasQr: false });
        } catch (dbErr) {
            console.error(`[manager] account ${accountId} failed to persist initialize error`, dbErr.message);
        }

        try {
            await client.destroy();
        } catch (_destroyErr) {
            // Browser may already be gone
        }

        if (!INIT_RETRYABLE_PATTERN.test(message)) {
            return;
        }

        const retries = (this.initializeRetries.get(accountId) || 0) + 1;
        this.initializeRetries.set(accountId, retries);
        if (retries > INIT_MAX_RETRIES) {
            console.error(`[manager] account ${accountId} exceeded initialize retries (${INIT_MAX_RETRIES})`);
            return;
        }

        const delayMs = INIT_RETRY_DELAY_MS * retries;
        console.warn(
            `[manager] account ${accountId} retry initialize in ${delayMs}ms (attempt ${retries}/${INIT_MAX_RETRIES})`
        );
        this.scheduleRestart(accountId, delayMs);
    }

    attachEvents(client, accountId) {
        client.on('qr', async (qr) => {
            console.log(`[manager] account ${accountId} QR received`);
            this.qrCodes.set(accountId, qr);
            await storage.saveQr(accountId, qr);
            this.broadcastStatus(accountId, 'qr', { hasQr: true });
            let qrImage = null;
            try {
                qrImage = await QRCode.toDataURL(qr, { width: 240 });
            } catch (_err) {
                qrImage = null;
            }
            this.broadcast('qr', { accountId, qr, qrImage });
        });

        client.on('authenticated', async () => {
            console.log(`[manager] account ${accountId} authenticated`);
            this.qrCodes.delete(accountId);
            await storage.clearQr(accountId);
            await storage.updateAccount(accountId, { status: 'authenticated' });
            this.broadcastStatus(accountId, 'authenticated', { hasQr: false });
            this.scheduleReadyWarning(accountId);
        });

        client.on('ready', async () => {
            console.log(`[manager] account ${accountId} ready`);
            this.clearReadyWarning(accountId);
            this.initializeRetries.delete(accountId);
            const info = client.info || {};
            const phoneNumber = info.wid ? info.wid.user : null;
            const readyAt = Date.now();
            const meta = this.accountMeta.get(accountId) || {};
            this.accountMeta.set(accountId, {
                skipHistoryBeforeReady: !!meta.skipHistoryBeforeReady,
                lastReadyAt: readyAt
            });
            await storage.updateAccount(accountId, {
                status: 'ready',
                phone_number: phoneNumber,
                last_ready_at: readyAt
            });
            this.broadcastStatus(accountId, 'ready', { hasQr: false, phoneNumber });
            await this.syncChats(accountId);
        });

        client.on('disconnected', async (reason) => {
            const reasonText = this.normalizeDisconnectReason(reason);
            console.warn(`[manager] account ${accountId} disconnected (${reasonText})`);
            this.clearReadyWarning(accountId);
            this.qrCodes.delete(accountId);
            await storage.updateAccount(accountId, { status: 'disconnected' });
            this.broadcastStatus(accountId, 'disconnected', { reason: reasonText, hasQr: false });

            // whatsapp-web.js reinitializes LocalAuth itself on LOGOUT; avoid spawning a second client.
            if (reasonText.toUpperCase() === 'LOGOUT') {
                return;
            }

            if (this.clients.get(accountId) === client) {
                this.clients.delete(accountId);
            }
            await this.destroyClientSafely(accountId, client, 'disconnect');
            this.scheduleRestart(accountId, 5000);
        });

        client.on('auth_failure', async (msg) => {
            console.error('Auth failure', msg);
            this.clearReadyWarning(accountId);
            await storage.updateAccount(accountId, { status: 'auth_failed' });
            this.broadcastStatus(accountId, 'auth_failed', { reason: msg, hasQr: false });
        });

        client.on('error', async (err) => {
            console.error(`Client error on account ${accountId}`, err?.message || err);
            this.clearReadyWarning(accountId);
            this.qrCodes.delete(accountId);
            if (this.clients.get(accountId) === client) {
                this.clients.delete(accountId);
            }
            await this.destroyClientSafely(accountId, client, 'error');
            await storage.updateAccount(accountId, { status: 'error' });
            this.broadcastStatus(accountId, 'error', { reason: err?.message || 'Unknown error', hasQr: false });
        });

        client.on('loading_screen', (percent, message) => {
            const info = message ? ` - ${message}` : '';
            console.log(`[manager] account ${accountId} loading ${percent}%${info}`);
        });

        client.on('change_state', (state) => {
            console.log(`[manager] account ${accountId} state ${state}`);
        });

        const handleIncoming = (msg) => {
            if (msg.fromMe) return; // avoid double-fire with message_create
            return this.persistMessage(accountId, msg);
        };

        client.on('message', handleIncoming);

        client.on('message_ack', async (msg, ack) => {
            try {
                const messageId = msg?.id?._serialized;
                if (!messageId || typeof ack !== 'number') {
                    return;
                }

                const ackTimestamp = await storage.updateMessageAck(accountId, messageId, ack);
                const chatId = msg.from || msg.to || msg.id?.remote || (await msg.getChat())?.id?._serialized || null;
                this.broadcast('message', {
                    accountId,
                    message: {
                        messageId,
                        whatsappChatId: chatId,
                        ack,
                        ackTimestamp
                    },
                    type: 'ack'
                });
            } catch (err) {
                console.error('Failed to update ack', err.message);
            }
        });
    }

    attachPuppeteerDebug(client, accountId) {
        const tryAttach = () => {
            const page = client.pupPage;
            if (!page || page.__debugAttached) return false;
            page.__debugAttached = true;
            page.on('console', (msg) => {
                const message = msg.text();
                if (IGNORED_WA_CONSOLE_PATTERNS.some(pattern => message.includes(pattern))) {
                    return;
                }
                console.log(`[wa-console] account ${accountId} ${msg.type()}: ${message}`);
            });
            page.on('pageerror', (err) => {
                console.error(`[wa-pageerror] account ${accountId}: ${err.message}`);
            });
            page.on('error', (err) => {
                console.error(`[wa-pageerror] account ${accountId}: ${err?.message || err}`);
            });
            page.on('response', (res) => {
                const url = res.url();
                if (res.status() >= 400 && !IGNORED_WA_RESPONSE_PATTERNS.some(pattern => url.includes(pattern))) {
                    console.warn(`[wa-response] account ${accountId} ${res.status()} ${url}`);
                }
            });
            return true;
        };

        if (tryAttach()) return;

        const interval = setInterval(() => {
            if (tryAttach()) {
                clearInterval(interval);
            }
        }, 1000);

        setTimeout(() => {
            clearInterval(interval);
        }, 60000);
    }

    async syncChats(accountId) {
        const maxAttempts = 3;
        const baseDelayMs = 1200;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const client = this.getClient(accountId);
                if (!client) return;

                const chats = await client.getChats();
                for (const chat of chats) {
                    if (this.isStatusBroadcast(chat.id?._serialized)) {
                        continue;
                    }
                    await storage.upsertChat(accountId, {
                        id: chat.id._serialized,
                        name: this.resolveChatName(chat),
                        isGroup: chat.isGroup
                    });
                }
                this.broadcast('chats_synced', {
                    accountId,
                    syncedAt: Date.now(),
                    count: chats.length
                });
                return;
            } catch (err) {
                const message = err?.message || String(err);
                const isTargetClosed = TARGET_CLOSED_PATTERN.test(message);
                const hasClient = !!this.getClient(accountId);

                if (isTargetClosed && hasClient && attempt < maxAttempts) {
                    const delayMs = baseDelayMs * attempt;
                    console.warn(
                        `[manager] account ${accountId} chat sync retry ${attempt}/${maxAttempts - 1} after page reset`
                    );
                    await new Promise((resolve) => setTimeout(resolve, delayMs));
                    continue;
                }

                if (isTargetClosed) {
                    console.warn(`[manager] account ${accountId} chat sync skipped (WhatsApp page closed)`);
                    return;
                }

                console.error('Failed to sync chats', message);
                return;
            }
        }
    }

    scheduleReadyWarning(accountId) {
        this.clearReadyWarning(accountId);
        const timeout = setTimeout(() => {
            console.warn(
                `[manager] account ${accountId} still not ready after authentication. `
                + 'Check WhatsApp Web, network, or Chromium sandbox settings.'
            );
        }, 60000);
        this.readyTimers.set(accountId, timeout);
    }

    clearReadyWarning(accountId) {
        const existing = this.readyTimers.get(accountId);
        if (existing) {
            clearTimeout(existing);
            this.readyTimers.delete(accountId);
        }
    }

    broadcastStatus(accountId, status, extra = {}) {
        this.broadcast('status', {
            accountId,
            status,
            ...extra
        });
    }

    setSkipHistory(accountId, skip, lastReadyAtOverride = null) {
        const meta = this.accountMeta.get(accountId) || {};
        const lastReadyAt = typeof lastReadyAtOverride === 'number'
            ? lastReadyAtOverride
            : meta.lastReadyAt || (skip ? Date.now() : null);
        this.accountMeta.set(accountId, {
            skipHistoryBeforeReady: !!skip,
            lastReadyAt
        });
    }

    async persistMessage(accountId, msg, options = {}) {
        const { silent = false, updateChatSummary = true } = options;
        try {
            const sourceId = msg.from || msg.to || msg.id?.remote || '';
            if (sourceId === STATUS_BROADCAST_ID) {
                return null;
            }

            let chat = null;
            try {
                chat = await msg.getChat();
            } catch (_err) {
                chat = null;
            }

            const chatWhatsappId = chat?.id?._serialized || sourceId;
            if (!chatWhatsappId || chatWhatsappId === STATUS_BROADCAST_ID) {
                return null;
            }

            let contact = null;
            try {
                contact = await msg.getContact();
            } catch (_err) {
                contact = null;
            }
            await storage.upsertChat(accountId, {
                id: chatWhatsappId,
                name: this.resolveChatName(chat, contact),
                isGroup: !!chat?.isGroup || String(chatWhatsappId).endsWith('@g.us')
            });

            const chatRecord = await storage.getChatByWhatsappId(accountId, chatWhatsappId);

            const isInteractive = msg.type === 'interactive' || msg._data?.type === 'interactive';

            let mediaPayload = {};
            if (msg.hasMedia && !isInteractive) {
                let media = null;
                try {
                    media = await msg.downloadMedia();
                } catch (err) {
                    console.warn(
                        `[manager] skipped media download for account ${accountId} ` +
                        `${chatWhatsappId} (${err?.message || err})`
                    );
                }
                if (media) {
                    const mediaBytes = this.getBase64ByteLength(media.data);
                    mediaPayload = {
                        mediaMime: media.mimetype,
                        mediaData: mediaBytes <= MAX_STORED_MEDIA_BYTES ? media.data : null,
                        mediaFilename: media.filename || `file-${msg.id.id}`
                    };
                    if (mediaBytes > MAX_STORED_MEDIA_BYTES) {
                        console.warn(
                            `[manager] skipped storing large media for account ${accountId} `
                            + `(${mediaBytes} bytes > ${MAX_STORED_MEDIA_BYTES})`
                        );
                    }
                }
            }

            const meta = this.accountMeta.get(accountId) || {};
            const ts = (msg.timestamp || Math.floor(Date.now() / 1000)) * 1000;
            if (meta.skipHistoryBeforeReady && meta.lastReadyAt && ts < meta.lastReadyAt) {
                return null;
            }

            const messageId = msg.id?._serialized || msg.id?.id || crypto
                .createHash('sha1')
                .update([
                    accountId,
                    chatWhatsappId,
                    msg.from || '',
                    msg.to || '',
                    msg.timestamp || '',
                    msg.body || ''
                ].join('|'))
                .digest('hex');

            const authorId = msg.author
                || (!msg.fromMe ? msg.from : (msg.to || null))
                || null;

            const saved = await storage.saveMessage(accountId, chatRecord, {
                chatWhatsappId,
                messageId,
                sender: msg.fromMe ? 'You' : (contact?.pushname || contact?.name || contact?.number || 'Contact'),
                authorId,
                fromMe: msg.fromMe,
                body: msg.body || (msg.hasMedia ? (isInteractive ? '[Interactive]' : '[Media]') : ''),
                messageType: msg.type,
                timestamp: (msg.timestamp || Math.floor(Date.now() / 1000)) * 1000,
                ack: typeof msg.ack === 'number' ? msg.ack : null,
                ackSentAt: msg.fromMe && typeof msg.ack === 'number' && msg.ack >= 1 ? Date.now() : null,
                ...mediaPayload
            });

            if (!saved) {
                return null;
            }

            if (updateChatSummary) {
                await storage.updateChatLastMessage(
                    accountId,
                    chatWhatsappId,
                    saved.body,
                    saved.timestamp
                );
            }

            if (!silent) {
                this.broadcast('message', {
                    accountId,
                    message: saved
                });
                if (saved && !saved.fromMe) {
                    this.automation.handleInboundMessage(accountId, saved).catch((err) => {
                        console.error('Automation failed', err.message);
                    });
                }
            }

            return saved;
        } catch (err) {
            const messageId = msg?.id?._serialized || 'unknown';
            const chatId = msg?.from || msg?.to || msg?.id?.remote || 'unknown';
            console.error(`Failed to persist message ${messageId} in ${chatId}`, err?.message || err);
            return null;
        }
    }

    async fetchAndStoreMessages(accountId, whatsappChatId, limit = 50) {
        const client = this.getClient(accountId);
        if (!client) {
            throw new Error('Account client not ready');
        }
        const chat = await client.getChatById(whatsappChatId);
        const messages = await chat.fetchMessages({ limit });
        let latest = null;
        for (const msg of messages) {
            const saved = await this.persistMessage(accountId, msg, {
                silent: true,
                updateChatSummary: false
            });
            if (saved && (!latest || (saved.timestamp || 0) > (latest.timestamp || 0))) {
                latest = saved;
            }
        }
        if (latest) {
            await storage.updateChatLastMessage(
                accountId,
                whatsappChatId,
                latest.body,
                latest.timestamp
            );
        }
        return storage.getMessages(accountId, whatsappChatId, limit);
    }

    async sendMessage(accountId, target, message, media) {
        const client = this.getClient(accountId);
        if (!client) {
            throw new Error('Account client not available');
        }

        const resolved = await this.resolveSendTarget(client, target);

        // Disable sendSeen to avoid upstream WA web regression (markedUnread undefined) that breaks sendMessage.
        const sendOptions = { sendSeen: false };
        let sentMessage;
        let outgoingMedia = {};

        if (media) {
            const { mimetype, data, filename } = media;
            const providedUrl = this.getProvidedMediaUrl(media);
            if (!mimetype || (!data && !providedUrl)) {
                throw new Error('Media mimetype and data or url are required');
            }
            const base64Data = data
                ? this.normalizeBase64(data)
                : await this.downloadMediaUrlWithFallback(providedUrl);
            if (!base64Data) {
                throw new Error('Media data is not valid base64');
            }
            try {
                Buffer.from(base64Data, 'base64');
            } catch (_err) {
                throw new Error('Media data is not valid base64');
            }
            outgoingMedia = {
                mediaUrl: this.saveOutgoingMediaFile(accountId, media, base64Data),
                mediaMime: mimetype,
                mediaFilename: filename || 'attachment'
            };
            const mediaMsg = new MessageMedia(mimetype, base64Data, filename || 'attachment');
            const options = message ? { caption: message, ...sendOptions } : sendOptions;
            sentMessage = await client.sendMessage(resolved, mediaMsg, options);
        } else {
            sentMessage = await client.sendMessage(resolved, message, sendOptions);
        }

        const sentAt = Date.now();
        const messageId = sentMessage?.id?._serialized || null;
        const whatsappChatId = sentMessage?.to || sentMessage?.from || resolved;
        const body = message || (media ? '[Media]' : '');

        await storage.upsertChat(accountId, {
            id: whatsappChatId,
            name: whatsappChatId,
            isGroup: String(whatsappChatId).endsWith('@g.us')
        });
        await storage.updateChatLastMessage(accountId, whatsappChatId, body, sentAt);
        await storage.saveOutgoingMessage({
            accountId,
            target,
            resolvedTarget: resolved,
            whatsappChatId,
            messageId,
            body,
            messageType: media ? 'media' : 'chat',
            status: 'sent',
            sentAt,
            ack: typeof sentMessage?.ack === 'number' ? sentMessage.ack : null,
            ackSentAt: typeof sentMessage?.ack === 'number' && sentMessage.ack >= 1 ? sentAt : null,
            ...outgoingMedia
        });

        return sentMessage;
    }

    parseDigits(raw) {
        return String(raw || '').replace(/\D+/g, '');
    }

    async resolveByNumberId(client, digits) {
        if (!digits) return null;
        try {
            const numberId = await client.getNumberId(digits);
            if (!numberId) return null;
            return numberId._serialized || numberId.user || null;
        } catch (_err) {
            return null;
        }
    }

    async resolveSendTarget(client, rawTarget) {
        const trimmed = String(rawTarget || '').trim();
        if (!trimmed) {
            const err = new Error('Target is required');
            err.statusCode = 400;
            throw err;
        }

        if (trimmed.includes('@')) {
            return trimmed;
        }

        const digits = this.parseDigits(trimmed);
        if (digits) {
            const candidates = [];
            const seen = new Set();
            const addCandidate = (value) => {
                if (!value || seen.has(value)) return;
                seen.add(value);
                candidates.push(value);
            };

            addCandidate(digits);
            if (digits.length === 10) addCandidate(`${DEFAULT_COUNTRY_CODE}${digits}`);
            if (digits.length > DEFAULT_COUNTRY_CODE.length && digits.startsWith(DEFAULT_COUNTRY_CODE)) {
                addCandidate(digits.slice(DEFAULT_COUNTRY_CODE.length));
            }

            for (const candidate of candidates) {
                const resolved = await this.resolveByNumberId(client, candidate);
                if (resolved) return resolved;
            }

            for (const candidate of candidates) {
                const cUs = `${candidate}@c.us`;
                try {
                    const isRegistered = await client.isRegisteredUser(cUs);
                    if (isRegistered) return cUs;
                } catch (_err) {
                    // Ignore isRegisteredUser failures and fall through to chat lookup.
                }
            }
        }

        const chats = await client.getChats();
        const foundByName = chats.find(chat => chat.name && chat.name.toLowerCase() === trimmed.toLowerCase());
        if (foundByName) {
            return foundByName.id._serialized;
        }

        if (digits) {
            const foundByDigits = chats.find((chat) => {
                const chatId = chat.id?._serialized || '';
                const userPart = String(chat.id?.user || '').replace(/\D+/g, '');
                return chatId.includes(digits) || (userPart && (userPart.endsWith(digits) || digits.endsWith(userPart)));
            });
            if (foundByDigits) {
                return foundByDigits.id._serialized;
            }
        }

        const err = new Error('Target number is not registered on WhatsApp');
        err.statusCode = 422;
        throw err;
    }

    normalizeBase64(raw) {
        if (!raw) return null;
        let str = String(raw).trim();
        if (str.includes('base64,')) {
            str = str.split('base64,').pop();
        }
        str = str.replace(/\s+/g, '');
        const pad = str.length % 4;
        if (pad === 1) return null;
        if (pad === 2) str += '==';
        if (pad === 3) str += '=';
        return str;
    }

    getBase64ByteLength(base64Data) {
        const normalized = this.normalizeBase64(base64Data);
        if (!normalized) return 0;
        const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
        return Math.floor((normalized.length * 3) / 4) - padding;
    }

    mediaExtension(mimetype = '') {
        const map = {
            'image/jpeg': 'jpg',
            'image/png': 'png',
            'image/webp': 'webp',
            'application/pdf': 'pdf',
            'video/mp4': 'mp4',
            'audio/mpeg': 'mp3',
            'audio/ogg': 'ogg'
        };
        return map[mimetype] || (mimetype.split('/').pop() || 'bin').replace(/[^a-z0-9]+/gi, '').toLowerCase() || 'bin';
    }

    safeFilename(filename = 'attachment') {
        return String(filename)
            .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '-')
            .replace(/\s+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 120) || 'attachment';
    }

    getProvidedMediaUrl(media = {}) {
        const rawUrl = media.url || media.mediaUrl || media.fileUrl || media.sourceUrl;
        if (!rawUrl) return null;
        const value = String(rawUrl).trim();
        return /^https?:\/\//i.test(value) ? value : null;
    }

    async downloadMediaUrlWithFallback(mediaUrl) {
        try {
            return await this.downloadMediaUrl(mediaUrl);
        } catch (err) {
            const fallbackUrl = this.getLabmateFallbackUrl(mediaUrl);
            if (!fallbackUrl || fallbackUrl === mediaUrl) {
                throw err;
            }
            return this.downloadMediaUrl(fallbackUrl);
        }
    }

    getLabmateFallbackUrl(mediaUrl) {
        try {
            const parsed = new URL(mediaUrl);
            if (parsed.hostname !== LABMATE_PUBLIC_HOST) {
                return null;
            }
            parsed.hostname = LABMATE_DOWNLOAD_FALLBACK_HOST;
            return parsed.toString();
        } catch (_err) {
            return null;
        }
    }

    downloadMediaUrl(mediaUrl, redirects = 0) {
        return new Promise((resolve, reject) => {
            if (redirects > 5) {
                reject(new Error('Too many media redirects'));
                return;
            }

            const parsed = new URL(mediaUrl);
            const client = parsed.protocol === 'https:' ? https : http;
            const options = {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                rejectUnauthorized: false
            };

            const req = client.get(mediaUrl, options, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    const nextUrl = new URL(res.headers.location, mediaUrl).toString();
                    this.downloadMediaUrl(nextUrl, redirects + 1).then(resolve, reject);
                    return;
                }

                if (res.statusCode !== 200) {
                    res.resume();
                    reject(new Error(`Media download failed with HTTP ${res.statusCode}`));
                    return;
                }

                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    const buffer = Buffer.concat(chunks);
                    if (!buffer.length) {
                        reject(new Error('Downloaded media is empty'));
                        return;
                    }
                    resolve(buffer.toString('base64'));
                });
            });

            req.setTimeout(30000, () => {
                req.destroy(new Error('Media download timed out'));
            });
            req.on('error', reject);
        });
    }

    saveOutgoingMediaFile(accountId, media, base64Data) {
        const providedUrl = this.getProvidedMediaUrl(media);
        if (providedUrl) {
            return providedUrl;
        }
        if (!base64Data) {
            return null;
        }

        const accountDir = path.join(OUTGOING_MEDIA_ROOT, String(accountId));
        fs.mkdirSync(accountDir, { recursive: true });

        const originalName = this.safeFilename(media.filename || `attachment.${this.mediaExtension(media.mimetype)}`);
        const hasExtension = path.extname(originalName);
        const filename = hasExtension
            ? originalName
            : `${originalName}.${this.mediaExtension(media.mimetype)}`;
        const storedName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${filename}`;
        fs.writeFileSync(path.join(accountDir, storedName), Buffer.from(base64Data, 'base64'));
        return `/api/outgoing-media/${accountId}/${encodeURIComponent(storedName)}`;
    }

    async backfillRecentMessages(accountId) {
        try {
            const client = this.getClient(accountId);
            if (!client) return;
            const cutoff = Date.now() - BACKFILL_WINDOW_MS;
            const chats = await client.getChats();
            for (const chat of chats) {
                if (this.isStatusBroadcast(chat.id?._serialized)) {
                    continue;
                }
                const messages = await chat.fetchMessages({ limit: BACKFILL_FETCH_LIMIT });
                let latest = null;
                for (const msg of messages) {
                    const ts = (msg.timestamp || Math.floor(Date.now() / 1000)) * 1000;
                    if (ts < cutoff) continue;
                    const saved = await this.persistMessage(accountId, msg, {
                        silent: true,
                        updateChatSummary: false
                    });
                    if (saved && (!latest || (saved.timestamp || 0) > (latest.timestamp || 0))) {
                        latest = saved;
                    }
                }
                if (latest) {
                    await storage.updateChatLastMessage(
                        accountId,
                        chat.id._serialized,
                        latest.body,
                        latest.timestamp
                    );
                }
            }
            this.broadcast('chats_synced', {
                accountId,
                syncedAt: Date.now(),
                backfilled: true
            });
        } catch (err) {
            console.error('Failed to backfill messages', err.message);
        }
    }

    async shutdown() {
        for (const timer of this.restartTimers.values()) {
            clearTimeout(timer);
        }
        this.restartTimers.clear();
        for (const client of this.clients.values()) {
            try {
                await client.destroy();
            } catch (err) {
                console.error('Error destroying client', err.message);
            }
        }
    }
}

module.exports = AccountManager;
