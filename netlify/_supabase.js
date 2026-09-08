// Shared helper: creates a Supabase client using the SECRET key.
// This file is never itself deployed as an endpoint (its name starts
// with "_", which Netlify skips when mapping files to routes) — it's
// just a module the other functions in this folder import.
//
// The secret key bypasses Row Level Security entirely, so every function
// that uses this client is responsible for checking the caller's identity
// and permissions itself (see requireCoach / requireAdmin below) rather
// than relying on RLS to do it — RLS still protects the database from
// anything that talks to Supabase directly with the public/publishable
// key (the frontend), which is the split this app relies on.

const { createClient } = require('@supabase/supabase-js');

function getAdminClient() {
  const url = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secretKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY environment variables');
  }
  return createClient(url, secretKey);
}

// Verifies the request's bearer token against Supabase Auth and returns
// the matching coaches row (or null if not logged in / not a known coach).
async function requireCoach(event, supabase) {
  const authHeader = event.headers.authorization || event.headers.Authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length);

  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData || !userData.user) return null;

  const { data: coachRow, error: coachErr } = await supabase
    .from('coaches')
    .select('id, display_name, is_admin')
    .eq('id', userData.user.id)
    .single();
  if (coachErr || !coachRow) return null;

  return coachRow;
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

module.exports = { getAdminClient, requireCoach, jsonResponse };
