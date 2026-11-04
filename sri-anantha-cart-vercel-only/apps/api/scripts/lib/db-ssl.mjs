// PostgreSQL TLS options shared by the API, worker and scripts.
//   DATABASE_SSL=true                    encrypt and verify the server certificate
//   DATABASE_SSL_CA=<PEM>                the provider's CA certificate (Supabase: Database settings > SSL);
//                                        literal "\n" sequences are accepted for single-line env values
//   DATABASE_SSL_REJECT_UNAUTHORIZED=false   only for local experiments; refused in production by the API
export function databaseSslOptions(env = process.env) {
  if (env.DATABASE_SSL !== 'true') return {};
  const ca = env.DATABASE_SSL_CA ? env.DATABASE_SSL_CA.replace(/\\n/g, '\n') : undefined;
  return { ssl: { rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false', ...(ca ? { ca } : {}) } };
}
