/**
 * SPOTTR — Daily database backup
 * pg_dump -> S3 at s3://spottr-imagery/db-backups/spottr_YYYY-MM-DD_HH-MM.dump
 * Deletes backups older than 30 days.
 *
 * Usage: node scripts/backup_db.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { execSync } = require('child_process');
const AWS = require('aws-sdk');
const { createReadStream, unlinkSync, statSync } = require('fs');
const path = require('path');
const os = require('os');

const BUCKET = process.env.S3_BUCKET || 'spottr-imagery';
const PREFIX = 'db-backups/';
const RETENTION_DAYS = 30;

const s3 = new AWS.S3({
  region: process.env.AWS_REGION || 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

function isoStamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())}_${pad(now.getUTCHours())}-${pad(now.getUTCMinutes())}`;
}

async function dumpToS3() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.error('ERROR: DATABASE_URL not set'); process.exit(1); }
  if (!process.env.AWS_ACCESS_KEY_ID) { console.error('ERROR: AWS_ACCESS_KEY_ID not set'); process.exit(1); }

  const stamp = isoStamp();
  const filename = `spottr_${stamp}.dump`;
  const tmpPath = path.join(os.tmpdir(), filename);
  const s3Key = `${PREFIX}${filename}`;

  console.log(`[${new Date().toISOString()}] Starting backup -> ${filename}`);

  // pg_dump in custom format (-Fc), no password prompt (URL contains credentials)
  execSync(`pg_dump "${dbUrl}" -Fc -f "${tmpPath}"`, {
    env: { ...process.env, PGPASSWORD: '' },
    stdio: 'inherit',
  });

  const size = statSync(tmpPath).size;
  console.log(`Dump complete: ${(size / 1024 / 1024).toFixed(2)} MB`);

  // Upload to S3
  console.log(`Uploading to s3://${BUCKET}/${s3Key} ...`);
  await s3.upload({
    Bucket: BUCKET,
    Key: s3Key,
    Body: createReadStream(tmpPath),
    ContentType: 'application/octet-stream',
    Metadata: { created: new Date().toISOString(), size_bytes: String(size) },
  }).promise();
  console.log(`Upload complete.`);

  // Clean up local tmp file
  unlinkSync(tmpPath);

  return { s3Key, size };
}

async function pruneOldBackups() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);

  const listed = await s3.listObjectsV2({ Bucket: BUCKET, Prefix: PREFIX }).promise();
  const toDelete = (listed.Contents || []).filter(obj => new Date(obj.LastModified) < cutoff);

  if (toDelete.length === 0) {
    console.log('No old backups to prune.');
    return;
  }

  await s3.deleteObjects({
    Bucket: BUCKET,
    Delete: { Objects: toDelete.map(o => ({ Key: o.Key })) },
  }).promise();
  console.log(`Pruned ${toDelete.length} backup(s) older than ${RETENTION_DAYS} days.`);
}

async function main() {
  try {
    const { s3Key, size } = await dumpToS3();
    await pruneOldBackups();
    console.log(`[${new Date().toISOString()}] Backup finished: s3://${BUCKET}/${s3Key} (${(size/1024/1024).toFixed(2)} MB)`);
  } catch (err) {
    console.error('Backup failed:', err.message);
    process.exit(1);
  }
}

main();
