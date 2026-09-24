require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { initDatabase, pool } = require('./utils/db');
const storage = require('./services/storage');
const AccountManager = require('./services/accountManager');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3004;
const GROUP_MANAGER_PASSWORD = process.env.GROUP_MANAGER_PASSWORD || 'Arpra#0000';
const TRANSIENT_BROWSER_ERROR = /execution context was destroyed|target closed|session closed|cannot find context with specified id/i;
const GROUP_CATEGORIES = new Set(['client', 'internal', 'vacancy', 'vendor']);
const app = express();
app.use(express.json({ limit: '10mb' }));

process.on('unhandledRejection', (reason) => {
    const message = reason?.message || String(reason || '');
    if (TRANSIENT_BROWSER_ERROR.test(message)) {
        console.warn(`[process] ignored transient browser rejection: ${message}`);
        return;
    }
    console.error('[process] unhandled rejection', reason);
});

process.on('uncaughtException', (err) => {
    const message = err?.message || String(err || '');
    if (TRANSIENT_BROWSER_ERROR.test(message)) {
        console.warn(`[process] ignored transient browser exception: ${message}`);
        return;
    }
    console.error('[process] uncaught exception', err);
    process.exit(1);
});

function isProtectedGroupManagerPath(req) {
    const pathOnly = req.path || '';
    if (pathOnly === '/groups.html') return true;
    if (/^\/api\/accounts\/\d+\/live-groups$/.test(pathOnly)) return true;
    if (/^\/api\/accounts\/\d+\/groups\//.test(pathOnly)) return true;
    return false;
}

function verifyPassword(provided, expected) {
    const providedBuffer = Buffer.from(String(provided || ''));
    const expectedBuffer = Buffer.from(String(expected || ''));
    return providedBuffer.length === expectedBuffer.length
        && crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

function requireGroupManagerPassword(req, res, next) {
    if (!isProtectedGroupManagerPath(req)) {
        return next();
    }

    const auth = req.headers.authorization || '';
    const [scheme, encoded] = auth.split(' ');
    if (scheme === 'Basic' && encoded) {
        const decoded = Buffer.from(encoded, 'base64').toString('utf8');
        const password = decoded.includes(':') ? decoded.slice(decoded.indexOf(':') + 1) : decoded;
        if (verifyPassword(password, GROUP_MANAGER_PASSWORD)) {
            return next();
        }
    }

    res.set('WWW-Authenticate', 'Basic realm="Group Manager"');
    return res.status(401).send('Authentication required');
}

app.use(requireGroupManagerPassword);
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/outgoing-media', express.static(path.join(__dirname, 'data', 'outgoing-media')));
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

function normalizePhone(value) {
    const digits = String(value || '').replace(/\D+/g, '');
    if (digits.length === 10) return `91${digits}`;
    return digits;
}

function normalizeGroupMappingId(value) {
    return String(value || '').trim().replace(/@g\.us$/i, '');
}

function formatParticipantId(phone) {
    const digits = normalizePhone(phone);
    if (!digits || digits.length < 8) {
        const err = new Error('Valid phone number is required');
        err.statusCode = 400;
        throw err;
    }
    return `${digits}@c.us`;
}

function serializeWid(value) {
    return value?._serialized || value?.toString?.() || value || null;
}

function parseParticipant(participant) {
    const rawId = participant?.id?._serialized || participant?.id?.toString?.() || participant?.id || '';
    const number = normalizePhone(rawId);
    return number ? { number, isAdmin: !!participant?.isAdmin, isSuperAdmin: !!participant?.isSuperAdmin } : null;
}

function getCurrentAccountIds(client, account) {
    return new Set([
        client.info?.wid?._serialized,
        client.info?.wid?.user ? `${client.info.wid.user}@c.us` : null,
        account.phone_number ? `${String(account.phone_number).replace(/\D+/g, '')}@c.us` : null
    ].filter(Boolean));
}

async function loadLiveGroups(client, account) {
    const myIds = getCurrentAccountIds(client, account);
    const isCurrentAccountAdmin = (participants = []) => {
        const me = participants.find((participant) => {
            const id = participant?.id?._serialized || participant?.id?.toString?.() || participant?.id || '';
            return myIds.has(id);
        });
        return !!(me && (me.isAdmin || me.isSuperAdmin));
    };

    try {
        const chats = await client.getChats();
        return chats
            .filter((chat) => chat.isGroup)
            .map((chat) => {
                const participants = chat.participants || chat.groupMetadata?.participants || [];
                const parsedParticipants = participants.map(parseParticipant).filter(Boolean);
                return {
                    id: chat.id?._serialized || null,
                    name: manager.resolveChatName(chat),
                    participantCount: parsedParticipants.length,
                    participants: parsedParticipants,
                    isAdmin: isCurrentAccountAdmin(participants)
                };
            });
    } catch (chatErr) {
        console.warn('Falling back to raw live group count', chatErr.message);
        return client.pupPage.evaluate((currentAccountIds) => {
            const ids = new Set(currentAccountIds);
            try {
                const { getMaybeMeLidUser, getMaybeMePnUser } = window.require('WAWebUserPrefsMeUser');
                const lidUser = getMaybeMeLidUser();
                const pnUser = getMaybeMePnUser();
                if (lidUser?._serialized) ids.add(lidUser._serialized);
                if (pnUser?._serialized) ids.add(pnUser._serialized);
            } catch (_err) {
                // Continue with Node-side account ids.
            }

            const getId = (value) => value?._serialized || value?.toString?.() || value || '';
            const toParticipants = (participants = []) => {
                const values = Array.isArray(participants)
                    ? participants
                    : participants?.serialize?.() || participants?.models || participants?.getModelsArray?.() || [];
                return values
                    .map((participant) => {
                        const rawId = getId(participant?.id);
                        let number = rawId.replace(/\D+/g, '');
                        try {
                            if (participant?.id?.server === 'lid') {
                                const phoneWid = window.require('WAWebApiContact').getPhoneNumber(participant.id);
                                number = getId(phoneWid).replace(/\D+/g, '') || number;
                            }
                        } catch (_err) {
                            // Keep the raw id digits if phone mapping is unavailable.
                        }
                        return number
                            ? {
                                number,
                                isAdmin: !!participant.isAdmin,
                                isSuperAdmin: !!participant.isSuperAdmin,
                                isMe: ids.has(rawId)
                            }
                            : null;
                    })
                    .filter(Boolean);
            };

            const chats = window.require('WAWebCollections').Chat.getModelsArray();
            return chats
                .filter((chat) => {
                    const id = getId(chat.id);
                    return chat.isGroup || id.endsWith('@g.us') || chat.id?.server === 'g.us';
                })
                .map((chat) => {
                    const id = getId(chat.id) || null;
                    const participants = toParticipants(chat.groupMetadata?.participants || chat.participants);
                    return {
                        id,
                        name: chat.name || chat.formattedTitle || chat.groupMetadata?.subject || id,
                        participantCount: participants.length,
                        participants,
                        isAdmin: !!(chat.iAmAdmin?.() || participants.some((p) => p.isMe && (p.isAdmin || p.isSuperAdmin)))
                    };
                });
        }, Array.from(myIds));
    }
}

async function syncLiveGroupCategories(groups) {
    if (!groups.length) return new Map();

    const values = groups
        .map((group) => {
            const groupId = normalizeGroupMappingId(group.id);
            const groupName = String(group.name || groupId || 'Unnamed group').slice(0, 255);
            return groupId ? [groupId, groupName] : null;
        })
        .filter(Boolean);

    if (!values.length) return new Map();

    await pool.query(
        `INSERT INTO unofc_group_categories (group_id, group_name, category)
         VALUES ?
         ON DUPLICATE KEY UPDATE group_name = VALUES(group_name)`,
        [values.map(([groupId, groupName]) => [groupId, groupName, 'internal'])]
    );

    const [rows] = await pool.query(
        `SELECT group_id, group_name, category
         FROM unofc_group_categories
         WHERE group_id IN (?)`,
        [values.map(([groupId]) => groupId)]
    );

    const categories = new Map();
    for (const row of rows) {
        categories.set(normalizeGroupMappingId(row.group_id), {
            groupName: row.group_name,
            category: GROUP_CATEGORIES.has(row.category) ? row.category : 'internal'
        });
    }
    return categories;
}

async function saveGroupCategory(groupId, groupName, category) {
    const normalizedGroupId = normalizeGroupMappingId(groupId);
    if (!normalizedGroupId) {
        const err = new Error('Group id is required');
        err.statusCode = 400;
        throw err;
    }
    if (!GROUP_CATEGORIES.has(category)) {
        const err = new Error('Invalid category');
        err.statusCode = 400;
        throw err;
    }

    const safeName = String(groupName || normalizedGroupId).slice(0, 255);
    await pool.query(
        `INSERT INTO unofc_group_categories (group_id, group_name, category)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE group_name = VALUES(group_name), category = VALUES(category)`,
        [normalizedGroupId, safeName, category]
    );

    return {
        groupId: normalizedGroupId,
        groupName: safeName,
        category
    };
}

async function modifyLiveGroupParticipant(client, groupId, participantId, action) {
    return client.pupPage.evaluate(async (targetGroupId, targetParticipantId, requestedAction) => {
        const WidFactory = window.require('WAWebWidFactory');
        const ChatCollection = window.require('WAWebCollections').Chat;
        const ModifyParticipants = window.require('WAWebModifyParticipantsGroupAction');
        const getId = (value) => value?._serialized || value?.toString?.() || value || '';
        const getGroupChat = async (groupWid) => {
            const serializedId = getId(groupWid);
            const direct = ChatCollection.get(groupWid) || ChatCollection.get(serializedId);
            if (direct) {
                return direct;
            }

            const chats = ChatCollection.getModelsArray?.() || [];
            const found = chats.find((chat) => getId(chat.id) === serializedId);
            if (found) {
                return found;
            }

            try {
                return await window.WWebJS.getChat(serializedId, { getAsModel: false });
            } catch (_err) {
                return null;
            }
        };
        const groupWid = WidFactory.createWid(targetGroupId);
        const chat = await getGroupChat(groupWid);
        if (!chat) {
            return { success: false, status: 404, error: 'Group not found' };
        }
        if (!chat.iAmAdmin?.()) {
            return { success: false, status: 403, error: 'Logged-in account is not admin in this group' };
        }

        const { lid, phone } = await window.WWebJS.enforceLidAndPnRetrieval(targetParticipantId);
        const participant = chat.groupMetadata.participants.get(lid?._serialized)
            || chat.groupMetadata.participants.get(phone?._serialized);

        if (requestedAction === 'remove') {
            if (!participant) {
                return { success: false, status: 404, error: 'Participant not found in group' };
            }
            await ModifyParticipants.removeParticipants(chat, [participant]);
            return { success: true, status: 200 };
        }

        const participantWid = phone || lid || WidFactory.createWid(targetParticipantId);
        const errorCodes = {
            200: 'The participant was added successfully',
            403: 'The participant can be added by sending private invitation only',
            404: 'The phone number is not registered on WhatsApp',
            408: 'You cannot add this participant because they recently left the group',
            409: 'The participant is already a group member',
            417: "The participant can't be added to the community",
            419: "The participant can't be added because the group is full"
        };

        const participants = chat.groupMetadata?.participants?.serialize?.() || [];
        const alreadyInGroup = participants.some((item) => {
            const itemId = item?.id?._serialized || item?.id?.toString?.() || '';
            return itemId === participantWid._serialized || itemId === lid?._serialized || itemId === phone?._serialized;
        });
        if (alreadyInGroup) {
            return { success: false, status: 409, code: 409, error: errorCodes[409] };
        }

        const exists = await window.require('WAWebQueryExistsJob').queryWidExists(participantWid);
        if (!exists?.wid) {
            return { success: false, status: 404, code: 404, error: errorCodes[404] };
        }

        const rpcResult = await window.WWebJS.getAddParticipantsRpcResult(groupWid, participantWid);
        const code = Number(rpcResult?.code || 400);
        if (code === 200) {
            return { success: true, status: 200, code, message: errorCodes[200] };
        }

        return {
            success: false,
            status: code >= 400 && code < 500 ? code : 500,
            code,
            error: errorCodes[code] || 'Unable to add participant'
        };
    }, groupId, participantId, action);
}

async function promoteLiveGroupParticipants(client, groupId, participantIds) {
    if (!participantIds.length) {
        return { success: true, status: 200, promoted: [] };
    }

    return client.pupPage.evaluate(async (targetGroupId, targetParticipantIds) => {
        const WidFactory = window.require('WAWebWidFactory');
        const ChatCollection = window.require('WAWebCollections').Chat;
        const ModifyParticipants = window.require('WAWebModifyParticipantsGroupAction');
        const groupWid = WidFactory.createWid(targetGroupId);
        const chat = ChatCollection.get(groupWid) || await ChatCollection.find(groupWid);
        if (!chat) {
            return { success: false, status: 404, error: 'Group not found' };
        }
        if (!chat.iAmAdmin?.()) {
            return { success: false, status: 403, error: 'Logged-in account is not admin in this group' };
        }

        const participants = (
            await Promise.all(targetParticipantIds.map(async (participantId) => {
                const { lid, phone } = await window.WWebJS.enforceLidAndPnRetrieval(participantId);
                return chat.groupMetadata.participants.get(lid?._serialized)
                    || chat.groupMetadata.participants.get(phone?._serialized);
            }))
        ).filter(Boolean);

        if (!participants.length) {
            return { success: false, status: 404, error: 'No requested participants found in group' };
        }

        await ModifyParticipants.promoteParticipants(chat, participants);
        return {
            success: true,
            status: 200,
            promoted: participants.map((participant) => participant.id?._serialized || participant.id?.toString?.() || null)
        };
    }, groupId, participantIds);
}

async function setLiveGroupEveryoneCanSend(client, groupId) {
    return client.pupPage.evaluate(async (targetGroupId) => {
        const WidFactory = window.require('WAWebWidFactory');
        const ChatCollection = window.require('WAWebCollections').Chat;
        const SetProperty = window.require('WAWebSetPropertyGroupAction');
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const getId = (value) => value?._serialized || value?.toString?.() || value || '';
        const getGroupChat = async (groupWid) => {
            const serializedId = getId(groupWid);
            const direct = ChatCollection.get(groupWid) || ChatCollection.get(serializedId);
            if (direct) {
                return direct;
            }

            const chats = ChatCollection.getModelsArray?.() || [];
            const found = chats.find((chat) => getId(chat.id) === serializedId);
            if (found) {
                return found;
            }

            try {
                return await window.WWebJS.getChat(serializedId, { getAsModel: false });
            } catch (_err) {
                return null;
            }
        };
        const attempts = [];

        for (let attempt = 1; attempt <= 3; attempt += 1) {
            if (attempt > 1) {
                await sleep(1500 * attempt);
            }

            const groupWid = WidFactory.createWid(targetGroupId);
            const chat = await getGroupChat(groupWid);
            if (!chat) {
                attempts.push({ attempt, success: false, status: 404, error: 'Group not found' });
                continue;
            }

            try {
                await SetProperty.setGroupProperty(chat, 'announcement', 0);
                if (chat.groupMetadata) {
                    chat.groupMetadata.announce = false;
                }
                attempts.push({
                    attempt,
                    success: true,
                    status: 200,
                    announce: chat.groupMetadata?.announce ?? null
                });

                await sleep(700);
                const refreshedChat = await getGroupChat(groupWid);
                const announce = refreshedChat?.groupMetadata?.announce;
                if (announce === false || announce === 0 || announce === undefined) {
                    return { success: true, status: 200, attempts };
                }
            } catch (err) {
                attempts.push({
                    attempt,
                    success: false,
                    status: err.name === 'ServerStatusCodeError' ? 500 : 500,
                    error: err?.message || String(err)
                });
            }
        }

        return {
            success: false,
            status: 500,
            error: 'Unable to confirm group message setting update',
            attempts
        };
    }, groupId);
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

app.get('/api/accounts/:accountId/live-groups', async (req, res) => {
    const accountId = Number(req.params.accountId);
    const account = await storage.getAccountById(accountId);
    if (!account) {
        return res.status(404).json({ error: 'Account not found' });
    }
    if (account.status !== 'ready') {
        return res.status(409).json({ error: 'Account not ready' });
    }

    const client = manager.getClient(accountId);
    if (!client) {
        return res.status(409).json({ error: 'Account client not available' });
    }

    try {
        const liveGroups = await loadLiveGroups(client, account);
        const groupCategories = await syncLiveGroupCategories(liveGroups);
        const groups = liveGroups.map((group) => {
            const saved = groupCategories.get(normalizeGroupMappingId(group.id));
            const category = saved?.category || 'internal';
            return {
                ...group,
                category
            };
        });

        res.json({
            accountId,
            phoneNumber: account.phone_number,
            count: groups.length,
            adminCount: groups.filter((group) => group.isAdmin).length,
            items: groups
        });
    } catch (err) {
        console.error('Failed to load live groups', err.message);
        res.status(500).json({ error: 'Unable to load live groups' });
    }
});

app.post('/api/accounts/:accountId/groups/create', async (req, res) => {
    const accountId = Number(req.params.accountId);
    const { name, participants, adminParticipants } = req.body || {};
    const account = await storage.getAccountById(accountId);
    if (!account) {
        return res.status(404).json({ error: 'Account not found' });
    }

    const client = manager.getClient(accountId);
    if (!client) {
        return res.status(409).json({ error: 'Account client not available' });
    }

    const title = String(name || '').trim();
    if (!title) {
        return res.status(400).json({ success: false, error: 'Group name is required' });
    }
    if (!Array.isArray(participants) || !participants.length) {
        return res.status(400).json({ success: false, error: 'At least one participant number is required' });
    }

    try {
        const participantIds = participants.map(formatParticipantId);
        const adminParticipantIds = Array.isArray(adminParticipants)
            ? [...new Set(adminParticipants.map(formatParticipantId))]
            : [];
        const result = await client.createGroup(title, participantIds, {
            autoSendInviteV4: true,
            announce: false
        });
        if (typeof result === 'string') {
            return res.status(500).json({ success: false, error: result });
        }

        const groupId = serializeWid(result.gid);
        let everyoneCanSend = null;
        let sendSettingResult = null;
        let promoteResult = null;
        if (groupId) {
            try {
                sendSettingResult = await setLiveGroupEveryoneCanSend(client, groupId);
                everyoneCanSend = !!sendSettingResult.success;
            } catch (settingsErr) {
                console.warn('Failed to set group messages to everyone', settingsErr.message);
                sendSettingResult = { success: false, error: settingsErr.message };
                everyoneCanSend = false;
            }
        }
        if (groupId && adminParticipantIds.length) {
            const createdParticipants = result.participants || {};
            const promotableParticipantIds = adminParticipantIds.filter((participantId) => {
                const participantResult = createdParticipants[participantId];
                return !participantResult || participantResult.statusCode === 200;
            });
            try {
                promoteResult = await promoteLiveGroupParticipants(client, groupId, promotableParticipantIds);
            } catch (promoteErr) {
                console.warn('Failed to promote group admins', promoteErr.message);
                promoteResult = { success: false, error: promoteErr.message };
            }
        }
        if (groupId) {
            try {
                sendSettingResult = await setLiveGroupEveryoneCanSend(client, groupId);
                everyoneCanSend = !!sendSettingResult.success;
                console.log(
                    `[groups] group ${groupId} everyone-can-send result: ${JSON.stringify(sendSettingResult)}`
                );
            } catch (settingsErr) {
                console.warn('Failed to confirm group messages to everyone', settingsErr.message);
                sendSettingResult = { success: false, error: settingsErr.message };
                everyoneCanSend = false;
            }
        }
        if (groupId) {
            await storage.upsertChat(accountId, {
                id: groupId,
                name: title,
                isGroup: true
            });
            await saveGroupCategory(groupId, title, 'internal');
        }

        res.status(201).json({
            success: true,
            groupId,
            name: result.title || title,
            everyoneCanSend,
            sendSettingResult,
            promoteResult,
            participants: result.participants || {},
            result
        });
    } catch (err) {
        const status = err.statusCode || 500;
        res.status(status).json({ success: false, error: err.message || 'Unable to create group' });
    }
});

app.put('/api/accounts/:accountId/groups/:groupId/category', async (req, res) => {
    const accountId = Number(req.params.accountId);
    const groupId = decodeURIComponent(req.params.groupId || '').trim();
    const account = await storage.getAccountById(accountId);
    if (!account) {
        return res.status(404).json({ success: false, error: 'Account not found' });
    }

    try {
        const category = String(req.body?.category || '').trim().toLowerCase();
        const groupName = req.body?.groupName || groupId;
        const saved = await saveGroupCategory(groupId, groupName, category);
        res.json({ success: true, ...saved });
    } catch (err) {
        const status = err.statusCode || 500;
        res.status(status).json({ success: false, error: err.message || 'Unable to save category' });
    }
});

app.post('/api/accounts/:accountId/groups/:groupId/participants/add', async (req, res) => {
    const accountId = Number(req.params.accountId);
    const groupId = decodeURIComponent(req.params.groupId || '').trim();
    const account = await storage.getAccountById(accountId);
    if (!account) {
        return res.status(404).json({ error: 'Account not found' });
    }
    const client = manager.getClient(accountId);
    if (!client) {
        return res.status(409).json({ error: 'Account client not available' });
    }

    try {
        const participantId = formatParticipantId(req.body?.phone || req.body?.number);
        const result = await modifyLiveGroupParticipant(client, groupId, participantId, 'add');
        if (!result.success) {
            return res.status(result.status || 500).json(result);
        }
        res.json({ success: true, groupId, participantId, result: result.result || result });
    } catch (err) {
        const status = err.statusCode || 500;
        res.status(status).json({ success: false, error: err.message || 'Unable to add participant' });
    }
});

app.post('/api/accounts/:accountId/groups/:groupId/participants/remove', async (req, res) => {
    const accountId = Number(req.params.accountId);
    const groupId = decodeURIComponent(req.params.groupId || '').trim();
    const account = await storage.getAccountById(accountId);
    if (!account) {
        return res.status(404).json({ error: 'Account not found' });
    }
    const client = manager.getClient(accountId);
    if (!client) {
        return res.status(409).json({ error: 'Account client not available' });
    }

    try {
        const participantId = formatParticipantId(req.body?.phone || req.body?.number);
        const result = await modifyLiveGroupParticipant(client, groupId, participantId, 'remove');
        if (!result.success) {
            return res.status(result.status || 500).json(result);
        }
        res.json({ success: true, groupId, participantId, result });
    } catch (err) {
        const status = err.statusCode || 500;
        res.status(status).json({ success: false, error: err.message || 'Unable to remove participant' });
    }
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
        console.error('Failed to send message', err?.stack || err?.message || err);
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
        console.error('Failed to send message', err?.stack || err?.message || err);
        const status = err.message === 'Duplicate send in progress'
            ? 429
            : (err.statusCode || 500);
        res.status(status).json({ error: err?.message || String(err) || 'Send failed' });
    }
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
