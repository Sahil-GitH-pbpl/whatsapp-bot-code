const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const DB_CONFIG = {
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'whatsapp_control',
    waitForConnections: true,
    connectionLimit: 10,
    namedPlaceholders: true
};

const pool = mysql.createPool(DB_CONFIG);

const legacyConfig = {
    host: process.env.WA_HOST,
    user: process.env.WA_USER,
    password: process.env.WA_PASSWORD,
    database: process.env.WA_NAME,
    waitForConnections: true,
    connectionLimit: 5,
    namedPlaceholders: true
};

const legacyPool = legacyConfig.host
    ? mysql.createPool(legacyConfig)
    : null;

async function waitForConnection(retries = 20, delayMs = 3000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const conn = await pool.getConnection();
            conn.release();
            return;
        } catch (err) {
            if (attempt === retries) throw err;
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
}

async function initDatabase() {
    await waitForConnection();
    const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf-8');
    const statements = sql
        .split(/;\s*(?:\r?\n|$)/)
        .map(stmt => stmt.trim())
        .filter(Boolean);

    for (const statement of statements) {
        await pool.query(statement);
    }

    const [acctColumns] = await pool.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'unofc_accounts'`
    );
    const acctNames = new Set(acctColumns.map(c => c.COLUMN_NAME));
    const acctAlters = [];
    if (!acctNames.has('skip_history_before_ready')) acctAlters.push('ADD COLUMN skip_history_before_ready TINYINT(1) NOT NULL DEFAULT 0 AFTER session_folder');
    if (!acctNames.has('last_ready_at')) acctAlters.push('ADD COLUMN last_ready_at BIGINT NULL AFTER skip_history_before_ready');
    if (acctAlters.length) {
        await pool.query(`ALTER TABLE unofc_accounts ${acctAlters.join(', ')}`);
    }

    const [centerColumns] = await pool.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'unofc_center'`
    );
    const centerNames = new Set(centerColumns.map(c => c.COLUMN_NAME));
    if (!centerNames.has('auto_reply')) {
        await pool.query('ALTER TABLE unofc_center ADD COLUMN auto_reply TINYINT(1) NOT NULL DEFAULT 0 AFTER assignmenttype');
    }
}

module.exports = {
    pool,
    legacyPool,
    initDatabase
};
