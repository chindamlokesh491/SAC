import type { Pool } from 'pg';

export type IssueOtpChallengeResult =
  | { kind: 'created'; id: string }
  | { kind: 'cooldown' }
  | { kind: 'hourly_limit' };

/**
 * Atomically enforces the per-phone resend cooldown and creates one active challenge.
 * The advisory lock serializes concurrent requests for the same normalized phone.
 */
export async function issueOtpChallenge(
  pool: Pool,
  phone: string,
  codeHash: string,
  ttlSeconds: number,
  cooldownSeconds: number,
  maxPerHour = 5,
): Promise<IssueOtpChallengeResult> {
  if (!/^\+[1-9][0-9]{7,14}$/.test(phone)) throw new Error('Invalid normalized phone number');
  if (!/^[a-f0-9]{64}$/i.test(codeHash)) throw new Error('Invalid OTP hash');
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 900) throw new Error('Invalid OTP TTL');
  if (!Number.isInteger(cooldownSeconds) || cooldownSeconds < 1 || cooldownSeconds > 3600) throw new Error('Invalid OTP cooldown');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`otp-request:${phone}`]);
    const recent = await client.query(
      `SELECT 1 FROM otp_challenges WHERE phone_e164 = $1 AND created_at > now() - ($2 * interval '1 second') LIMIT 1`,
      [phone, cooldownSeconds],
    );
    if (recent.rowCount) {
      await client.query('COMMIT');
      return { kind: 'cooldown' };
    }
    // Per-number cap protects against SMS pumping even when requests rotate IP addresses.
    const hourly = await client.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count FROM otp_challenges WHERE phone_e164 = $1 AND created_at > now() - interval '1 hour'`,
      [phone],
    );
    if (Number(hourly.rows[0]?.count ?? 0) >= maxPerHour) {
      await client.query('COMMIT');
      return { kind: 'hourly_limit' };
    }

    await client.query('UPDATE otp_challenges SET consumed_at = now() WHERE phone_e164 = $1 AND consumed_at IS NULL', [phone]);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO otp_challenges(phone_e164, code_hash, expires_at)
       VALUES ($1, $2, now() + ($3 * interval '1 second')) RETURNING id`,
      [phone, codeHash, ttlSeconds],
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error('OTP challenge insert returned no identifier');
    await client.query('COMMIT');
    return { kind: 'created', id };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
