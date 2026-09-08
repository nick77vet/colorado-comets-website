// /.netlify/functions/plays
//
// GET    ?scope=team   -> published plays visible to everyone
// GET    ?scope=mine   -> the logged-in coach's own drafts + their published plays
// POST   { name, snapshot, phaseIds, categoryIds, tagIds, status } -> create a play
// PUT    { id, name, snapshot, phaseIds, categoryIds, tagIds, status } -> update a play
// DELETE ?id=...       -> delete a play (only the creator's own drafts)
//
// Every request must include: Authorization: Bearer <supabase access token>

const { getAdminClient, requireCoach, jsonResponse } = require('./_supabase');

exports.handler = async function (event) {
  const supabase = getAdminClient();
  const coach = await requireCoach(event, supabase);
  if (!coach) return jsonResponse(401, { error: 'Not logged in' });

  if (event.httpMethod === 'GET') {
    return handleList(supabase, coach, event);
  }
  if (event.httpMethod === 'POST') {
    return handleCreate(supabase, coach, event);
  }
  if (event.httpMethod === 'PUT') {
    return handleUpdate(supabase, coach, event);
  }
  if (event.httpMethod === 'DELETE') {
    return handleDelete(supabase, coach, event);
  }
  return jsonResponse(405, { error: 'Method not allowed' });
};

async function fetchPlaysWithLabels(supabase, playsQuery) {
  const { data: plays, error } = await playsQuery;
  if (error) throw error;
  if (!plays || plays.length === 0) return [];

  const playIds = plays.map((p) => p.id);
  const { data: links, error: linkErr } = await supabase
    .from('play_labels')
    .select('play_id, labels ( id, kind, name )')
    .in('play_id', playIds);
  if (linkErr) throw linkErr;

  const labelsByPlay = {};
  (links || []).forEach((row) => {
    if (!labelsByPlay[row.play_id]) labelsByPlay[row.play_id] = [];
    if (row.labels) labelsByPlay[row.play_id].push(row.labels);
  });

  return plays.map((p) => ({
    id: p.id,
    name: p.name,
    snapshot: p.snapshot,
    status: p.status,
    createdBy: p.created_by,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    phases: (labelsByPlay[p.id] || []).filter((l) => l.kind === 'phase').map((l) => l.name),
    categories: (labelsByPlay[p.id] || []).filter((l) => l.kind === 'category').map((l) => l.name),
    tags: (labelsByPlay[p.id] || []).filter((l) => l.kind === 'tag').map((l) => l.name)
  }));
}

async function handleList(supabase, coach, event) {
  const scope = (event.queryStringParameters && event.queryStringParameters.scope) || 'team';
  let query;
  if (scope === 'mine') {
    query = supabase.from('plays').select('*').eq('created_by', coach.id).order('updated_at', { ascending: false });
  } else {
    query = supabase.from('plays').select('*').eq('status', 'published').order('updated_at', { ascending: false });
  }
  try {
    const plays = await fetchPlaysWithLabels(supabase, query);
    return jsonResponse(200, { plays });
  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
}

// A play must carry at least one Phase label and one Category label
// before it's allowed to be published — this is enforced here since
// Postgres can't express "at least one related row exists" as a plain
// column constraint.
function validateLabelsForPublish(phaseIds, categoryIds) {
  if (!phaseIds || phaseIds.length === 0) return 'Pick at least one Phase before publishing.';
  if (!categoryIds || categoryIds.length === 0) return 'Pick at least one Category before publishing.';
  return null;
}

async function handleCreate(supabase, coach, event) {
  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }
  const { name, snapshot, phaseIds = [], categoryIds = [], tagIds = [], status = 'draft' } = body;
  if (!name || !snapshot) return jsonResponse(400, { error: 'name and snapshot are required' });
  if (status === 'published') {
    const err = validateLabelsForPublish(phaseIds, categoryIds);
    if (err) return jsonResponse(400, { error: err });
  }

  const { data: play, error: insertErr } = await supabase
    .from('plays')
    .insert({ name, snapshot, status, created_by: coach.id })
    .select()
    .single();
  if (insertErr) return jsonResponse(500, { error: insertErr.message });

  const allLabelIds = [...phaseIds, ...categoryIds, ...tagIds];
  if (allLabelIds.length > 0) {
    const rows = allLabelIds.map((labelId) => ({ play_id: play.id, label_id: labelId }));
    const { error: linkErr } = await supabase.from('play_labels').insert(rows);
    if (linkErr) return jsonResponse(500, { error: linkErr.message });
  }

  return jsonResponse(201, { play });
}

async function handleUpdate(supabase, coach, event) {
  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }
  const { id, name, snapshot, phaseIds = [], categoryIds = [], tagIds = [], status } = body;
  if (!id) return jsonResponse(400, { error: 'id is required' });
  if (status === 'published') {
    const err = validateLabelsForPublish(phaseIds, categoryIds);
    if (err) return jsonResponse(400, { error: err });
  }

  // RLS on the plays table already restricts this update to plays the
  // coach is allowed to edit (their own draft, or any published play) —
  // but we use the secret key here, which bypasses RLS, so we replicate
  // that same check explicitly before writing.
  const { data: existing, error: fetchErr } = await supabase.from('plays').select('*').eq('id', id).single();
  if (fetchErr || !existing) return jsonResponse(404, { error: 'Play not found' });
  const canEdit = existing.created_by === coach.id || existing.status === 'published';
  if (!canEdit) return jsonResponse(403, { error: 'You can only edit your own drafts or published plays' });

  const updates = { updated_at: new Date().toISOString() };
  if (name !== undefined) updates.name = name;
  if (snapshot !== undefined) updates.snapshot = snapshot;
  if (status !== undefined) updates.status = status;

  const { error: updateErr } = await supabase.from('plays').update(updates).eq('id', id);
  if (updateErr) return jsonResponse(500, { error: updateErr.message });

  const { error: clearErr } = await supabase.from('play_labels').delete().eq('play_id', id);
  if (clearErr) return jsonResponse(500, { error: clearErr.message });

  const allLabelIds = [...phaseIds, ...categoryIds, ...tagIds];
  if (allLabelIds.length > 0) {
    const rows = allLabelIds.map((labelId) => ({ play_id: id, label_id: labelId }));
    const { error: linkErr } = await supabase.from('play_labels').insert(rows);
    if (linkErr) return jsonResponse(500, { error: linkErr.message });
  }

  return jsonResponse(200, { ok: true });
}

async function handleDelete(supabase, coach, event) {
  const id = event.queryStringParameters && event.queryStringParameters.id;
  if (!id) return jsonResponse(400, { error: 'id query parameter is required' });

  const { data: existing, error: fetchErr } = await supabase.from('plays').select('*').eq('id', id).single();
  if (fetchErr || !existing) return jsonResponse(404, { error: 'Play not found' });
  if (existing.created_by !== coach.id || existing.status !== 'draft') {
    return jsonResponse(403, { error: 'You can only delete your own drafts. Unpublish a published play before deleting it.' });
  }

  const { error: deleteErr } = await supabase.from('plays').delete().eq('id', id);
  if (deleteErr) return jsonResponse(500, { error: deleteErr.message });
  return jsonResponse(200, { ok: true });
}
