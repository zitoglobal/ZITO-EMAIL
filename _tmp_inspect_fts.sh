#!/bin/bash
set -e
echo '=== repo.js FTS lines ==='
grep -n 'messages_fts\|from_text\|INSERT INTO messages_fts' /opt/zito-mail/server/repo.js | head -40
echo '=== db.js FTS ==='
grep -n 'CREATE VIRTUAL\|from_text\|content' /opt/zito-mail/server/db.js | head -20
echo '=== schema ==='
cd /opt/zito-mail
node <<'NODE'
import { db } from './server/db.js';
console.log(db.prepare("SELECT sql FROM sqlite_master WHERE name='messages_fts'").get());
console.log(db.prepare('PRAGMA table_info(messages_fts)').all());
// find who uses from_name in fts
import fs from 'fs';
const repo = fs.readFileSync('./server/repo.js','utf8');
const hits = [...repo.matchAll(/messages_fts[^\n]{0,120}/g)].map(m=>m[0]);
console.log('repo hits', hits);
NODE
