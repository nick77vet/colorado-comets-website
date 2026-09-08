// /.netlify/functions/labels
//
// GET  -> all non-merged labels, grouped: { phases: [...], categories: [...], tags: [...] }
//         each item is { id, name }
// POST { kind: 'category'|'tag', name } -> create a new label (any coach may call this)
// POST { action: 'reassign', fromLabelId, toLabelId, playIds: [...] } -> admin only:
//         move the given plays off fromLabelId and onto toLabelId
// POST { action: 'delete', labelId } -> admin only: delete a label (must have 0 plays left)
//
// Every request must include: Authorization: Bearer <supabase access token>

const { getAdminClient, requireCoach, jsonResponse } = require('./_supabase');

exports.handler = async function (event) {
  const supabase = getAdminClient();
  const coach = await requireCoach(event, supabase);
  if (!coach) return jsonResponse(401, { error: 'Not logged in' });

  if (event.httpMethod === 'GET') {
    return handleList(supabase);
  }
  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body);
    } catch (e) {
      return jsonResponse(400, { error: 'Invalid JSON body' });
    }
    if (body.action === 'reassign') return handleReassign(supabase, coach, body);
    if (body.action === 'delete') return handleDeleteLabel(supabase, coach, body);
    return handleAddLabel(supabase, body);
  }
  return jsonResponse(405, { error: 'Method not allowed' });
};

async function handleList(supabase) {
  const { data, error } = await supabase
    .from('labels')
    .select('id, kind, name')
    .is('merged_into', null)
    .order('name');
  if (error) return jsonResponse(500, { error: error.message });

  const grouped = { phases: [], categories: [], tags: [] };
  (data || []).forEach((row) => {
    if (row.kind === 'phase') grouped.phases.push(row);
    if (row.kind === 'category') grouped.categories.push(row);
    if (row.kind === 'tag') grouped.tags.push(row);
  });
  return jsonResponse(200, grouped);
}

// Adding a new category/tag is open to any logged-in coach — the
// search-first + confirm-to-create flow that prevents near-duplicates
// ("Steal" vs "Steals") lives in the frontend; this endpoint just does
// a case-insensitive exact-match check as a last line of defense so two
// coaches racing to add the same name at once can't create two rows.
async function handleAddLabel(supabase, body) {
  const { kind, name } = body;
  if (kind !== 'category' && kind !== 'tag') {
    return jsonResponse(400, { error: 'kind must be "category" or "tag"' });
  }
  if (!name || !name.trim()) return jsonResponse(400, { error: 'name is required' });
  const trimmed = name.trim();

  const { data: existingRows, error: findErr } = await supabase
    .from('labels')
    .select('id, name')
    .eq('kind', kind)
    .is('merged_into', null);
  if (findErr) return jsonResponse(500, { error: findErr.message });

  const exact = (existingRows || []).find((r) => r.name.toLowerCase() === trimmed.toLowerCase());
  if (exact) return jsonResponse(200, { label: exact, alreadyExisted: true });

  const { data: created, error: insertErr } = await supabase
    .from('labels')
    .insert({ kind, name: trimmed })
    .select()
    .single();
  if (insertErr) return jsonResponse(500, { error: insertErr.message });
  return jsonResponse(201, { label: created, alreadyExisted: false });
}

function requireAdmin(coach) {
  return coach.is_admin === true;
}

// Moves a set of plays off one category and onto another — the bulk
// "move checked plays to..." action from the Manage Categories screen.
async function handleReassign(supabase, coach, body) {
  if (!requireAdmin(coach)) return jsonResponse(403, { error: 'Only admins can reassign categories' });
  const { fromLabelId, toLabelId, playIds } = body;
  if (!fromLabelId || !toLabelId || !Array.isArray(playIds) || playIds.length === 0) {
    return jsonResponse(400, { error: 'fromLabelId, toLabelId, and a non-empty playIds array are required' });
  }

  const { error: delErr } = await supabase
    .from('play_labels')
    .delete()
    .eq('label_id', fromLabelId)
    .in('play_id', playIds);
  if (delErr) return jsonResponse(500, { error: delErr.message });

  const rows = playIds.map((playId) => ({ play_id: playId, label_id: toLabelId }));
  const { error: insErr } = await supabase.from('play_labels').upsert(rows, { onConflict: 'play_id,label_id' });
  if (insErr) return jsonResponse(500, { error: insErr.message });

  const { count, error: countErr } = await supabase
    .from('play_labels')
    .select('play_id', { count: 'exact', head: true })
    .eq('label_id', fromLabelId);
  if (countErr) return jsonResponse(500, { error: countErr.message });

  return jsonResponse(200, { ok: true, remainingInSource: count || 0 });
}

// Deletes a label outright. Only safe to call once its play count is 0
// (the frontend prompts for this after a reassign empties a category) —
// enforced here too, not just trusted from the client.
async function handleDeleteLabel(supabase, coach, body) {
  if (!requireAdmin(coach)) return jsonResponse(403, { error: 'Only admins can delete categories' });
  const { labelId } = body;
  if (!labelId) return jsonResponse(400, { error: 'labelId is required' });

  const { count, error: countErr } = await supabase
    .from('play_labels')
    .select('play_id', { count: 'exact', head: true })
    .eq('label_id', labelId);
  if (countErr) return jsonResponse(500, { error: countErr.message });
  if ((count || 0) > 0) {
    return jsonResponse(409, { error: 'This category still has plays attached to it. Reassign them first.' });
  }

  const { error: delErr } = await supabase.from('labels').delete().eq('id', labelId);
  if (delErr) return jsonResponse(500, { error: delErr.message });
  return jsonResponse(200, { ok: true });
}
