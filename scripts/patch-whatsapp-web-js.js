const fs = require('fs');
const path = require('path');

const target = path.join(
    __dirname,
    '..',
    'node_modules',
    'whatsapp-web.js',
    'src',
    'util',
    'Injected',
    'Utils.js'
);

if (!fs.existsSync(target)) {
    console.warn('[patch] whatsapp-web.js Utils.js not found, skipping media id patch');
    process.exit(0);
}

const patch = `\n\n        // Current WhatsApp Web media models expose a private __x_id field.\n        // If it is spread into Msg data, it overwrites Msg's real id and\n        // WA getters crash with "Data passed to getter must include an id".\n        delete message.__x_id;`;

let source = fs.readFileSync(target, 'utf8');
if (source.includes('delete message.__x_id;')) {
    console.log('[patch] whatsapp-web.js media id patch already applied');
    process.exit(0);
}

const marker = [
    '            ...botOptions,',
    '            ...extraOptions,',
    '        };'
].join('\n');

if (!source.includes(marker)) {
    console.error('[patch] whatsapp-web.js media id patch marker not found');
    process.exit(1);
}

source = source.replace(marker, `${marker}${patch}`);
fs.writeFileSync(target, source);
console.log('[patch] whatsapp-web.js media id patch applied');
